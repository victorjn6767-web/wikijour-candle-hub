'use strict';
process.env.HUB_ALLOW_LOOPBACK = '1';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), util = require('util');
const { mock } = require('./mock-supabase'), { Store, assertHubUrl } = require('../src/hub/store'), P = require('../src/hub/policies');
const MONTH = 'fx/XAUUSD/2026-10.v1.m1.gz', RAW = 'raw/XAUUSD/2026/10/12.0123456789abcdef.bi5', STATE = 'state/XAUUSD.json', CAND = 'candidate/manifest.json';
async function setup() {
  const S = await mock().start(); S.addUser('w@x', 'pw-w', 'hub_writer'); S.addUser('r@x', 'pw-r', 'hub_reader'); S.addUser('n@x', 'pw-n', null);
  S.addUser('u@x', 'pw-u', null, { user_metadata: { hub_role: 'hub_writer' } });      // user-editable metadata must grant nothing
  const mk = (e, p) => new Store({ url: S.url, expectedHost: S.host, anonKey: S.anon, email: e, password: p });
  return { S, W: mk('w@x', 'pw-w'), R: mk('r@x', 'pw-r'), N: mk('n@x', 'pw-n'), U: mk('u@x', 'pw-u'), A: Object.assign(mk('w@x', 'pw-w'), { token: S.anon }) };
}
const rejects = async (p) => { try { await p; } catch (e) { return e.status || 0; } return false; };

test('committed sql/hub-policies.sql is exactly what the declaration generates', () => {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'sql', 'hub-policies.sql'), 'utf8'), P.generateSql());
});
test('no policy exists for anon, and every policy is limited to named roles and name patterns', () => {
  const sql = P.generateSql(); assert.ok(!/to anon/.test(sql)); assert.ok(!/to public/.test(sql));
  for (const p of P.POLICIES) { assert.ok(p.roles.length && p.roles.every(r => ['hub_writer', 'hub_reader'].includes(r))); assert.ok(p.name_rx.startsWith('^') && p.name_rx.endsWith('$')); }
  assert.ok(P.POLICIES.filter(p => p.roles.includes('hub_reader')).every(p => p.op === 'SELECT' && p.bucket === 'hub'), 'reader may only SELECT in bucket hub');
});
test('policy matrix: operations per role, bucket and object name', () => {
  const W = 'hub_writer', R = 'hub_reader', a = P.allowed;
  // reader: read published files only
  assert.ok(a('SELECT', 'hub', 'manifest.json', R) && a('SELECT', 'hub', 'manifest.sig', R) && a('SELECT', 'hub', MONTH, R));
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) for (const n of ['manifest.json', MONTH]) assert.ok(!a(op, 'hub', n, R), `reader ${op} ${n}`);
  for (const n of [RAW, STATE, CAND]) for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.ok(!a(op, 'hub-raw', n, R), `reader ${op} hub-raw/${n}`);
  // writer in hub: month files are write-once (INSERT, DELETE for GC), manifest pair is mutable but never deletable
  assert.ok(a('INSERT', 'hub', MONTH, W) && a('DELETE', 'hub', MONTH, W) && !a('UPDATE', 'hub', MONTH, W));
  assert.ok(a('INSERT', 'hub', 'manifest.json', W) && a('UPDATE', 'hub', 'manifest.json', W) && a('UPDATE', 'hub', 'manifest.sig', W) && !a('DELETE', 'hub', 'manifest.json', W) && !a('DELETE', 'hub', 'manifest.sig', W));
  // writer in hub-raw: raw day immutable (+delete for repair), state/candidate mutable but not deletable
  assert.ok(a('INSERT', 'hub-raw', RAW, W) && !a('UPDATE', 'hub-raw', RAW, W) && a('DELETE', 'hub-raw', RAW, W) && a('SELECT', 'hub-raw', RAW, W));
  for (const n of [STATE, CAND]) assert.ok(a('INSERT', 'hub-raw', n, W) && a('UPDATE', 'hub-raw', n, W) && a('SELECT', 'hub-raw', n, W) && !a('DELETE', 'hub-raw', n, W), n);
  // names outside the schema, wrong buckets, case tricks, traversal, anonymous / unknown roles
  for (const n of ['evil.txt', '../etc/passwd', 'fx/xauusd/2026-10.v1.m1.gz', 'fx/XAUUSD/2026-10.v1.m1.gz/extra', 'fx/XAUUSD/../2026-10.v1.m1.gz', 'manifest.json/x', 'raw/XAUUSD/2026/10/12.bi5', '']) for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) for (const b of ['hub', 'hub-raw']) assert.ok(!a(op, b, n, W), `writer ${op} ${b}/${n}`);
  assert.ok(!a('INSERT', 'hub', RAW, W) && !a('INSERT', 'hub-raw', MONTH, W) && !a('INSERT', 'other', MONTH, W));
  for (const r of ['', '__anon', 'hub_admin', 'service' + '_role']) for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.ok(!a(op, 'hub', 'manifest.json', r) && !a(op, 'hub-raw', STATE, r));
});
test('through the Storage API: reader can read published files and nothing else', async () => {
  const { S, W, R } = await setup(); t_after(S);
  await W.put('hub', MONTH, Buffer.from('m')); await W.put('hub', 'manifest.json', Buffer.from('{}'), { upsert: true }); await W.put('hub-raw', STATE, Buffer.from('s'));
  assert.deepStrictEqual(await R.get('hub', MONTH), Buffer.from('m')); assert.deepStrictEqual(await R.get('hub', 'manifest.json'), Buffer.from('{}'));
  assert.strictEqual(await R.get('hub-raw', STATE), null, 'raw/state are invisible to the reader (looks like not found)');
  assert.strictEqual((await R.list('hub-raw', 'state')).length, 0);
  assert.ok(await rejects(R.put('hub', 'fx/XAUUSD/2026-11.v1.m1.gz', Buffer.from('x'))));
  assert.ok(await rejects(R.put('hub', 'manifest.json', Buffer.from('evil'), { upsert: true })));
  assert.ok(await rejects(R.put('hub', MONTH, Buffer.from('evil'), { upsert: true })));
  assert.ok(await rejects(R.del('hub', MONTH))); assert.ok(await rejects(R.del('hub', 'manifest.json'))); assert.ok(await rejects(R.put('hub-raw', RAW, Buffer.from('x'))));
  assert.deepStrictEqual(await W.get('hub', MONTH), Buffer.from('m'), 'nothing was modified by the reader');
});
test('through the Storage API: writer is limited to the declared operations', async () => {
  const { S, W } = await setup(); t_after(S);
  await W.put('hub', MONTH, Buffer.from('v1'));
  assert.strictEqual(await rejects(W.put('hub', MONTH, Buffer.from('changed'), { upsert: true })), 403, 'month versions are immutable');
  assert.strictEqual(await rejects(W.put('hub', MONTH, Buffer.from('dup'))), 409);
  await W.put('hub', 'manifest.json', Buffer.from('a'), { upsert: true }); await W.put('hub', 'manifest.json', Buffer.from('b'), { upsert: true });
  assert.strictEqual(await rejects(W.del('hub', 'manifest.json')), 403);
  await W.put('hub-raw', RAW, Buffer.from('r')); assert.strictEqual(await rejects(W.put('hub-raw', RAW, Buffer.from('r2'), { upsert: true })), 403, 'raw day files are immutable');
  assert.ok(await W.del('hub-raw', RAW) && await W.put('hub-raw', RAW, Buffer.from('r2')), 'repair = delete then write');
  await W.put('hub-raw', STATE, Buffer.from('1')); await W.put('hub-raw', STATE, Buffer.from('2'), { upsert: true }); assert.strictEqual(await rejects(W.del('hub-raw', STATE)), 403);
  for (const bad of ['evil.txt', 'fx/xauusd/2026-10.v1.m1.gz', 'raw/XAUUSD/2026/10/12.bi5']) assert.ok(await rejects(W.put('hub', bad, Buffer.from('x'))), bad);
  assert.ok(await rejects(W.put('other-bucket', MONTH, Buffer.from('x'))));
  assert.ok(await W.del('hub', MONTH), 'GC of old month versions is allowed');
});
test('anonymous key, signed-in user without role, and user_metadata role claims get nothing', async () => {
  const { S, W, N, U, A } = await setup(); t_after(S);
  await W.put('hub', 'manifest.json', Buffer.from('{}'), { upsert: true }); await W.put('hub-raw', STATE, Buffer.from('s'));
  for (const who of [N, U, A]) {
    assert.strictEqual(await who.get('hub', 'manifest.json'), null); assert.strictEqual(await who.get('hub-raw', STATE), null);
    assert.ok(await rejects(who.put('hub', 'manifest.json', Buffer.from('evil'), { upsert: true }))); assert.ok(await rejects(who.put('hub', MONTH, Buffer.from('x'))));
    assert.ok(await rejects(who.del('hub', MONTH)));
  }
  assert.strictEqual((await mockPublicStatus(S)), 400, 'private buckets expose no public URLs');
});
async function mockPublicStatus(S) { const r = await fetch(`${S.url}/storage/v1/object/public/hub/manifest.json`); return r.status; }
test('credentials never appear in errors, inspect output or JSON', async () => {
  const { S, R } = await setup(); t_after(S);
  await R.login(); const tok = R.token;
  const e = await R.put('hub', MONTH, Buffer.from('x')).catch(x => x); assert.ok(!e.message.includes(tok) && !e.message.includes('pw-r') && !e.message.includes(S.anon));
  assert.strictEqual(R.scrub(`boom ${tok} and ${S.anon} and pw-r`), 'boom *** and *** and ***');
  for (const s of [util.inspect(R, { depth: 5 }), JSON.stringify(R)]) { assert.ok(!s.includes(tok) && !s.includes('pw-r') && !s.includes(S.anon) && !s.includes('r@x') || !s.includes('pw-r')); assert.ok(!s.includes(tok)); assert.ok(!s.includes(S.anon)); }
  const bad = new Store({ url: S.url, expectedHost: S.host, anonKey: S.anon, email: 'r@x', password: 'wrong-password' });
  const e2 = await bad.login().then(() => null, x => x); assert.ok(e2 && !e2.message.includes('wrong-password'));
});
test('connection guard: only the configured Hub host, https only (loopback allowed in tests only)', () => {
  assert.throws(() => assertHubUrl('https://other.example.test', 'hubproj.example.test'), /not the configured/);
  assert.throws(() => assertHubUrl('http://hubproj.example.test', 'hubproj.example.test'), /https/);
  assert.throws(() => assertHubUrl('https://hubproj.example.test', ''), /not the configured/);
  assert.strictEqual(assertHubUrl('https://hubproj.example.test', 'hubproj.example.test'), 'https://hubproj.example.test');
  const keep = process.env.HUB_ALLOW_LOOPBACK; delete process.env.HUB_ALLOW_LOOPBACK;
  try { assert.throws(() => assertHubUrl('http://127.0.0.1:1', '127.0.0.1:1'), /https/); } finally { process.env.HUB_ALLOW_LOOPBACK = keep; }
});
test('an expired/invalid token triggers exactly one re-login and succeeds', async () => {
  const { S, W } = await setup(); t_after(S);
  await W.put('hub', MONTH, Buffer.from('m')); const before = S.logins; W.token = 'garbage'; assert.deepStrictEqual(await W.get('hub', MONTH), Buffer.from('m')); assert.strictEqual(S.logins, before + 1);
});
function t_after(S) { require('node:test').after(() => S.stop()); }
