'use strict';
// Whole-run tests: scripts/fetch.js and scripts/analyze.js as child processes against a local mock server.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { server, run } = require('./helpers');
const F = 'scripts/fetch.js', A = 'scripts/analyze.js';
const env = (S, work, extra) => Object.assign({ WORK_DIR: work, SYM: 'XAUUSD', FROM: '2026-10-05', TO: '2026-10-07', DK_BASE: `http://127.0.0.1:${S.port}/datafeed`, DK_WAIT_MS: '0', COOLDOWN_MS: '0', DAY_PAUSE_MS: '0', DK_TODAY: '2026-11-27', PASSES: '1', BUDGET_SEC: '60' }, extra || {});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
const st = w => JSON.parse(fs.readFileSync(path.join(w, 'state-XAUUSD.json'), 'utf8'));

test('resume: second invocation fetches only the failed day; complete days are not requested again', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); S.direct['2026-10-06'] = '503';
  let r = await run(F, env(S, w)); assert.strictEqual(r.code, 0);
  let s = st(w); assert.deepStrictEqual([s.days['2026-10-05'].kind, s.days['2026-10-06'].kind, s.days['2026-10-07'].kind], ['ok', 'fail', 'ok']);
  const h5 = S.hits.direct['2026-10-05'], h7 = S.hits.direct['2026-10-07']; assert.strictEqual(h5, 1); assert.ok(S.hits.direct['2026-10-06'] >= 4);
  delete S.direct['2026-10-06']; r = await run(F, env(S, w)); assert.match(r.out, /2 already complete \(resume\)/);
  s = st(w); assert.strictEqual(s.days['2026-10-06'].kind, 'ok'); assert.strictEqual(s.days['2026-10-06'].tries, 2);
  assert.strictEqual(S.hits.direct['2026-10-05'], h5); assert.strictEqual(S.hits.direct['2026-10-07'], h7); // not re-fetched
  assert.match(r.out, /complete: 3\/3/);
  const a = await run(A, env(S, w)); const rep = JSON.parse(a.out); assert.strictEqual(rep.pass, true); assert.deepStrictEqual(rep.checks.days.missing_after_all_retries, []);
  assert.ok(rep.fetch.direct.http503 >= 4); assert.deepStrictEqual(rep.fetch.proxy, {}); assert.strictEqual(rep.fetch.complete_days_by_source.direct, 3);
});
test('a corrupted or truncated stored file is detected and fetched again', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); await run(F, env(S, w));
  const f = path.join(w, 'raw', 'XAUUSD', '2026-10-05.bi5'); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 20));
  const before = S.hits.direct['2026-10-05']; const r = await run(F, env(S, w)); assert.match(r.out, /2 already complete/);
  assert.strictEqual(S.hits.direct['2026-10-05'], before + 1); assert.strictEqual(st(w).days['2026-10-05'].kind, 'ok');
});
test('HTTP 200 with garbage is not recorded as complete (direct), and nothing is stored for that day', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); S.direct['2026-10-06'] = 'garbage';
  const r = await run(F, env(S, w)); const s = st(w);
  assert.strictEqual(s.days['2026-10-06'].kind, 'fail'); assert.ok(!fs.existsSync(path.join(w, 'raw', 'XAUUSD', '2026-10-06.bi5')));
  assert.ok(s.stat.direct.invalid_lzma >= 4); assert.match(r.out, /still missing: 2026-10-06/);
});
test('proxy fallback e2e: direct throttled, proxy serves a valid day; garbage from the proxy is rejected and counted under proxy', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); S.direct['*'] = '503'; S.proxy['2026-10-07'] = 'garbage';
  await run(F, env(S, w, { DK_PROXY_URL: `http://127.0.0.1:${S.port}` })); const s = st(w);
  assert.strictEqual(s.days['2026-10-05'].kind, 'ok'); assert.strictEqual(s.days['2026-10-05'].via, 'proxy');
  assert.strictEqual(s.days['2026-10-07'].kind, 'fail'); assert.ok(s.stat.proxy.invalid_lzma >= 3); assert.ok(s.stat.direct.http503 > 0); assert.strictEqual(s.stat.direct.invalid_lzma, undefined);
});
test('breaker is per process: run 1 with a dead proxy opens it; run 2 (new process, proxy back) uses the proxy again and resumes', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); S.direct['*'] = '503'; S.proxy['*'] = 'drop';
  await run(F, env(S, w, { FROM: '2026-10-05', TO: '2026-10-09', DK_PROXY_URL: `http://127.0.0.1:${S.port}` })); let s = st(w);
  assert.strictEqual(s.stat.proxy.breaker_open, 1); assert.ok(Object.values(s.days).every(d => d.kind === 'fail'));
  const after1 = JSON.stringify(S.hits.proxy); S.proxy['*'] = 'ok';
  await run(F, env(S, w, { FROM: '2026-10-05', TO: '2026-10-09', DK_PROXY_URL: `http://127.0.0.1:${S.port}` })); s = st(w);
  assert.ok(Object.values(s.days).every(d => d.kind === 'ok' && d.via === 'proxy')); assert.notStrictEqual(JSON.stringify(S.hits.proxy), after1);
  assert.strictEqual(s.stat.proxy.breaker_open, 1); // history only; the breaker itself is not persisted
});
test('404: old day is an empty day; a day within 2 days of today is pending, not complete', async t => {
  const S = await server().start(), w = tmp(); t.after(() => S.stop()); S.direct['2026-10-05'] = '404'; S.direct['2026-10-07'] = '404';
  await run(F, env(S, w, { DK_TODAY: '2026-10-08' })); const s = st(w);
  assert.strictEqual(s.days['2026-10-05'].kind, 'none'); assert.strictEqual(s.days['2026-10-07'].kind, 'pending');
  const r = await run(F, env(S, w, { DK_TODAY: '2026-10-08' })); assert.match(r.out, /2 already complete/);
});
