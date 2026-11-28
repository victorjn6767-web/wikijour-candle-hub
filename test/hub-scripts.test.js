'use strict';
// The three operator scripts and the two workflows, against the simulated Supabase and a simulated Dukascopy. Nothing real is contacted.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { run, server } = require('./helpers'), { mock } = require('./mock-supabase'), { keyId, newKeyPair } = require('../src/hub/sign');
const ROOT = path.join(__dirname, '..'), S = f => path.join(ROOT, 'scripts', f), tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hubs-'));
const PW = 'writer-pass-9f3a', RPW = 'reader-pass-77c1';
async function world() {
  const D = await server().start(), M = await mock().start(); test.after(() => Promise.all([D.stop(), M.stop()]));
  M.addUser('w@x', PW, 'hub_writer'); M.addUser('r@x', RPW, 'hub_reader');
  const keys = newKeyPair(), trusted = path.join(tmp(), 'trusted.json'); fs.writeFileSync(trusted, JSON.stringify({ [keyId(keys.publicPem)]: keys.publicPem }));
  const base = { HUB_URL: M.url, HUB_HOST: M.host, HUB_ANON_KEY: M.anon, HUB_ALLOW_LOOPBACK: '1', HUB_WRITER_EMAIL: 'w@x', HUB_WRITER_PASSWORD: PW, DK_BASE: `http://127.0.0.1:${D.port}/datafeed`, DK_WAIT_MS: '1', DK_DIRECT_TRIES: '2', DK_TODAY: '2030-01-01', SYM: 'XAUUSD', FROM: '2026-10-01', TO: '2026-10-31', DIGITS: '3' };
  return { D, M, keys, trusted, base };
}
const noSecrets = (out, W) => { for (const s of [PW, RPW, W.keys.privatePem, W.M.anon]) assert.ok(!out.includes(s.trim()), 'a secret appeared in output'); assert.ok(!/PRIVATE KEY/.test(out)); };

test('keygen: writes the private key only to a 0600 file outside the repo, never prints it, refuses to overwrite', async () => {
  const d = tmp(), f = path.join(d, 'k.pem'), r = await run(S('hub-keygen.js'), {}, [f]);
  assert.strictEqual(r.code, 0, r.out); assert.ok(!/PRIVATE KEY/.test(r.out)); assert.ok(/BEGIN PUBLIC KEY/.test(r.out) && /key id: [0-9a-f]{16}/.test(r.out));
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600); const pem = fs.readFileSync(f, 'utf8'); assert.ok(/PRIVATE KEY/.test(pem));
  const id = /key id: ([0-9a-f]{16})/.exec(r.out)[1], json = JSON.parse(r.out.slice(r.out.indexOf('{\n')));
  assert.deepStrictEqual(Object.keys(json), [id]); assert.strictEqual(keyId(json[id]), id);
  assert.strictEqual(require('crypto').createPublicKey(require('crypto').createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }), json[id], 'public part belongs to the written private key');
  assert.strictEqual((await run(S('hub-keygen.js'), {}, [f])).code, 2, 'no overwrite'); assert.strictEqual((await run(S('hub-keygen.js'), {}, [path.join(ROOT, 'oops.pem')])).code, 2, 'not inside the repo'); assert.ok(!fs.existsSync(path.join(ROOT, 'oops.pem')));
  assert.strictEqual((await run(S('hub-keygen.js'), {}, [])).code, 2);
});
test('upload → sign → verify end to end; second upload downloads nothing; outputs contain no secrets', async () => {
  const W = await world(); let r = await run(S('hub-upload.js'), W.base); assert.strictEqual(r.code, 0, r.out); noSecrets(r.out, W);
  assert.match(r.out, /fetched: 26; failed: 0/); assert.match(r.out, /month 2026-10: rows=1560 .* published as v1/); assert.match(r.out, /NOT trusted until the sign job/);
  assert.deepStrictEqual([...W.M.buckets.hub.keys()], ['fx/XAUUSD/2026-10.v1.m1.gz'], 'only the month version is in the public-facing bucket; no manifest yet');
  const sign = Object.assign({}, W.base, { HUB_SIGNING_KEY: W.keys.privatePem, HUB_TRUSTED_FILE: W.trusted });
  r = await run(S('hub-sign.js'), sign); assert.strictEqual(r.code, 0, r.out); noSecrets(r.out, W); assert.match(r.out, /seq=1; reader-side verification passed for 1 month file/);
  r = await run(S('hub-upload.js'), W.base); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /skipped \(already complete remotely\): 26; fetched: 0/); assert.match(r.out, /unchanged v1/);
  r = await run(S('hub-sign.js'), sign); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /seq=2/);
});
test('upload: failed days make the run exit 3, publish nothing incomplete, and the next run resumes only those days', async () => {
  const W = await world(); W.D.direct['2026-10-13'] = '503'; W.D.direct['2026-10-14'] = '503';
  let r = await run(S('hub-upload.js'), W.base); assert.strictEqual(r.code, 3, r.out); assert.match(r.out, /failed: 2 \(2026-10-13,2026-10-14\)/); assert.match(r.out, /incomplete: 2026-10\(2 missing\)/); assert.strictEqual(W.M.buckets.hub.size, 0);
  delete W.D.direct['2026-10-13']; delete W.D.direct['2026-10-14']; W.D.hits.direct = {};
  r = await run(S('hub-upload.js'), W.base); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /fetched: 2; failed: 0/); assert.deepStrictEqual(Object.keys(W.D.hits.direct).sort(), ['2026-10-13', '2026-10-14']);
});
test('scripts refuse a wrong host, a bad symbol, missing configuration and a signing key that is not trusted — before any request', async () => {
  const W = await world();
  for (const [name, env, script, code] of [['host', { HUB_HOST: '127.0.0.1:1' }, 'hub-upload.js', 1], ['symbol', { SYM: 'xau/../' }, 'hub-upload.js', 1], ['no password', { HUB_WRITER_PASSWORD: '' }, 'hub-upload.js', 2], ['no url', { HUB_URL: '' }, 'hub-upload.js', 2]]) {
    const r = await run(S(script), Object.assign({}, W.base, env)); assert.strictEqual(r.code, code, name + ': ' + r.out);
  }
  assert.strictEqual(W.M.logins, 0, 'no login was attempted by any refused run');
  const other = newKeyPair(); let r = await run(S('hub-sign.js'), Object.assign({}, W.base, { HUB_SIGNING_KEY: other.privatePem, HUB_TRUSTED_FILE: W.trusted })); assert.strictEqual(r.code, 1); assert.match(r.out, /not listed in keys\/trusted\.json/); assert.ok(!r.out.includes('PRIVATE KEY'));
  r = await run(S('hub-sign.js'), Object.assign({}, W.base, { HUB_TRUSTED_FILE: W.trusted })); assert.strictEqual(r.code, 2, 'missing signing key'); assert.strictEqual(W.M.logins, 0);
  const empty = path.join(tmp(), 't.json'); fs.writeFileSync(empty, '{}'); r = await run(S('hub-sign.js'), Object.assign({}, W.base, { HUB_SIGNING_KEY: W.keys.privatePem, HUB_TRUSTED_FILE: empty })); assert.strictEqual(r.code, 1); assert.match(r.out, /no public key yet/);
  r = await run(S('hub-sign.js'), Object.assign({}, W.base, { HUB_SIGNING_KEY: W.keys.privatePem, HUB_TRUSTED_FILE: W.trusted })); assert.strictEqual(r.code, 1); assert.match(r.out, /no candidate/, 'sign before any upload fails safely');
});
test('selfcheck: passes against the intended model, fails loudly when an identity has too much power', async () => {
  const W = await world(), env = Object.assign({}, W.base, { HUB_READER_EMAIL: 'r@x', HUB_READER_PASSWORD: RPW, HUB_SELFCHECK_WRITE: '1' });
  let r = await run(S('hub-selfcheck.js'), env); assert.strictEqual(r.code, 0, r.out); assert.match(r.out, /all checks passed/); assert.ok(!/FAIL/.test(r.out)); assert.ok((r.out.match(/PASS/g) || []).length >= 25); noSecrets(r.out, W);
  assert.ok(![...W.M.buckets.hub.keys()].some(k => k.startsWith('manifest')), 'selfcheck never touches the manifest'); assert.deepStrictEqual([...W.M.buckets['hub-raw'].keys()], ['state/SELFTEST.json'], 'only the documented leftover remains');
  const bad = await world(); bad.M.addUser('r@x', RPW, 'hub_writer');                // misconfigured: the "reader" is really a writer
  r = await run(S('hub-selfcheck.js'), Object.assign({}, bad.base, { HUB_READER_EMAIL: 'r@x', HUB_READER_PASSWORD: RPW })); assert.strictEqual(r.code, 1); assert.match(r.out, /FAIL  reader: token role is hub_reader/); assert.match(r.out, /FAIL  reader: cannot write month file/);
  const anon = await world(); const r3 = await run(S('hub-selfcheck.js'), Object.assign({}, anon.base, { HUB_WRITER_EMAIL: '' })); assert.strictEqual(r3.code, 0, r3.out); assert.match(r3.out, /anon: cannot write hub/);
});
test('selfcheck: a server error or a dropped connection is never mistaken for "access denied"', async () => {
  const W = await world(); W.M.force = 500;
  const r = await run(S('hub-selfcheck.js'), Object.assign({}, W.base, { HUB_READER_EMAIL: 'r@x', HUB_READER_PASSWORD: RPW }));
  assert.strictEqual(r.code, 1, r.out); assert.match(r.out, /FAIL  reader: cannot write month file/); assert.match(r.out, /FAIL  anon: cannot write hub/);
});
test('workflows: manual only, read-only token, pinned actions, environments, no interpolated inputs or echoed secrets', () => {
  for (const f of ['hub-upload.yml', 'hub-sign.yml']) {
    const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
    assert.ok(/^on:\n  workflow_dispatch:/m.test(y) && !/pull_request|schedule:|push:/.test(y), f + ' triggers'); assert.ok(/^permissions:\n  contents: read$/m.test(y), f + ' permissions');
    assert.ok(/^    environment: hub-(prod|sign)$/m.test(y), f + ' environment'); assert.ok(/persist-credentials: false/.test(y));
    for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, 'unpinned action ' + m[1]);
    for (const m of y.matchAll(/^\s+run: (.*)$/gm)) assert.ok(!/\$\{\{/.test(m[1]), 'expression inside run: ' + m[1]);
    assert.ok(!/echo .*secrets\.|set -x|service[_-]?role|SERVICE[_-]?ROLE/i.test(y)); assert.ok(!/upload-artifact|actions\/cache/.test(y), 'no artifacts or cache');
  }
  const sign = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'hub-sign.yml'), 'utf8'), up = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'hub-upload.yml'), 'utf8');
  assert.ok(/HUB_SIGNING_KEY/.test(sign) && !/HUB_SIGNING_KEY/.test(up), 'only the sign job can see the signing key'); assert.ok(!/HUB_READER/.test(sign + up), 'reader credentials never go to GitHub');
});
