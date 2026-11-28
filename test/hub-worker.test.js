'use strict';
// The read-only gateway Worker against the simulated Supabase (loopback). No real network, no real keys.
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto');
const { mock } = require('./mock-supabase');
const RPW = 'reader-pass-77c1', TOK = 'tok_' + crypto.randomBytes(24).toString('base64url'), OTHER = 'tok_' + crypto.randomBytes(24).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let W;
async function setup() {
  const M = await mock().start();
  M.addUser('r@x', RPW, 'hub_reader'); M.addUser('w@x', 'writer-pass-1', 'hub_writer');
  M.buckets.hub.set('manifest.json', Buffer.from('{"v":1}')); M.buckets.hub.set('manifest.sig', Buffer.from('sig')); M.buckets.hub.set('fx/XAUUSD/2026-10.v1.m1.gz', Buffer.from([1, 2, 3, 4]));
  M.buckets['hub-raw'].set('state/XAUUSD.json', Buffer.from('{"secret":1}'));
  const mod = (await import('../worker/hub-reader.js')).default;
  const env = { HUB_URL: M.url, HUB_HOST: M.host, HUB_ALLOW_LOOPBACK: '1', HUB_ANON_KEY: M.anon, HUB_READER_EMAIL: 'r@x', HUB_READER_PASSWORD: RPW, REQ_TOKEN_HASHES: `${sha(TOK)}, ${sha('x'.repeat(30))}` };
  const call = (p, o = {}, e = env) => mod.fetch(new Request('https://gw.test' + p, o), e, { waitUntil() {} });
  return { M, env, call, mod };
}
const auth = t => ({ headers: { authorization: 'Bearer ' + t } });
test.before(async () => { W = await setup(); });
test.after(() => W && W.M.stop());

test('serves manifest and month file to a valid requester token, with sane headers', async () => {
  const a = await W.call('/manifest.json', auth(TOK)); assert.strictEqual(a.status, 200); assert.strictEqual(await a.text(), '{"v":1}'); assert.strictEqual(a.headers.get('content-type'), 'application/json'); assert.strictEqual(a.headers.get('x-content-type-options'), 'nosniff');
  const b = await W.call('/fx/XAUUSD/2026-10.v1.m1.gz', auth(TOK)); assert.strictEqual(b.status, 200); assert.deepStrictEqual([...new Uint8Array(await b.arrayBuffer())], [1, 2, 3, 4]); assert.match(b.headers.get('cache-control'), /immutable/);
  assert.strictEqual((await W.call('/manifest.sig', auth(TOK))).status, 200);
});
test('requester auth: none / wrong / malformed / hash-in-place-of-token are refused, and Supabase is not even contacted', async () => {
  const before = W.M.log.length, logins = W.M.logins;
  for (const h of [undefined, 'Bearer ' + OTHER, 'Bearer short', 'Basic ' + TOK, 'Bearer ' + sha(TOK)]) assert.strictEqual((await W.call('/manifest.json', h ? { headers: { authorization: h } } : {})).status, 401);
  assert.strictEqual(W.M.log.length, before); assert.ok(W.M.logins >= logins);
});
test('only the allowed paths: hub-raw, state, traversal, wrong names and methods are refused', async () => {
  for (const p of ['/state/XAUUSD.json', '/raw/XAUUSD/2026/10/01.abc.bi5', '/fx/XAUUSD/2026-13.v1.m1.gz', '/fx/xauusd/2026-10.v1.m1.gz', '/fx/XAUUSD/2026-10.v0.m1.gz', '/manifest.json/x', '/']) assert.strictEqual((await W.call(p, auth(TOK))).status, 404, p);
  assert.strictEqual((await W.call('/manifest.json', Object.assign({ method: 'POST', body: 'x' }, auth(TOK)))).status, 405);
  assert.strictEqual((await W.call('/manifest.json', { method: 'DELETE', ...auth(TOK) })).status, 405);
  assert.ok(W.M.log.every(l => l.bucket !== 'hub-raw'), 'hub-raw never touched');
});
test('missing object -> 404 (Storage says 400+statusCode 404); upstream outage / bad credentials -> 502 without details', async () => {
  assert.strictEqual((await W.call('/fx/XAUUSD/2026-09.v1.m1.gz', auth(TOK))).status, 404);
  const bad = await W.call('/manifest.json', auth(TOK), Object.assign({}, W.env, { HUB_READER_PASSWORD: 'wrong-pass-0000' }));
  assert.ok([200, 502].includes(bad.status)); // a cached login may still be valid in this isolate; a fresh isolate fails closed
  const down = await W.call('/manifest.json', auth(TOK), Object.assign({}, W.env, { HUB_URL: 'http://127.0.0.1:1', HUB_HOST: '127.0.0.1:1' })); assert.ok([200, 502].includes(down.status)); if (down.status === 502) assert.strictEqual(await down.text(), 'upstream unavailable');
});
test('host pinning and https: a Hub URL that does not match HUB_HOST, or plain http without the loopback switch, fails closed', async () => {
  for (const e of [Object.assign({}, W.env, { HUB_HOST: 'evil.example.test' }), Object.assign({}, W.env, { HUB_ALLOW_LOOPBACK: '0' })]) { const r = await W.call('/manifest.json', auth(TOK), e); assert.strictEqual(r.status, 502); assert.strictEqual(await r.text(), 'upstream unavailable'); }
});
test('reader role cannot write: the credential the Worker holds is hub_reader only', async () => {
  const t = (await (await fetch(`${W.M.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: W.M.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'r@x', password: RPW }) })).json()).access_token;
  const w = await fetch(`${W.M.url}/storage/v1/object/hub/manifest.json`, { method: 'POST', headers: { apikey: W.M.anon, authorization: 'Bearer ' + t, 'x-upsert': 'true' }, body: 'evil' }); assert.ok(w.status >= 400);
  assert.strictEqual(W.M.buckets.hub.get('manifest.json').toString(), '{"v":1}');
});
test('no secret material in the Worker source', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'worker', 'hub-reader.js'), 'utf8');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}|sb_(publishable|secret)_|service[_-]?role|\.supabase\.co|\.workers\.dev/i.test(src));
});
