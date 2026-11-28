'use strict';
// Upload job (environment hub-prod): download Dukascopy days -> validated raw store -> immutable month versions -> CANDIDATE manifest.
// It cannot sign or publish a trusted manifest (it has no signing key). Env: SYM, DKID, FROM, TO, DIGITS, BUDGET_SEC, optional DK_PROXY_URL.
const { fetchDay } = require('../src/dukascopy'), { Publisher } = require('../src/hub/publish'), { storeFor, fail, need } = require('../src/hub/env');
const SYM = need('SYM'), ID = process.env.DKID || SYM, FROM = need('FROM'), TO = need('TO'), DIGITS = +(process.env.DIGITS || 3), BUDGET = +(process.env.BUDGET_SEC || 1500) * 1000;
if (!/^[A-Z0-9]{3,12}$/.test(SYM) || !/^[A-Za-z0-9]+$/.test(ID) || !/^\d{4}-\d\d-\d\d$/.test(FROM) || !/^\d{4}-\d\d-\d\d$/.test(TO) || !(DIGITS >= 0 && DIGITS <= 8)) fail('bad SYM/DKID/FROM/TO/DIGITS');
const TODAY = process.env.DK_TODAY || new Date().toISOString().slice(0, 10), recent = d => Date.parse(TODAY + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z') < 2 * 864e5;
const dates = [], months = new Set();
for (let t = Date.parse(FROM + 'T00:00:00Z'); t <= Date.parse(TO + 'T00:00:00Z'); t += 864e5) { const dt = new Date(t); if (dt.getUTCDay() !== 6) { const s = dt.toISOString().slice(0, 10); dates.push(s); months.add(s.slice(0, 7)); } }
const stat = {}, t0 = Date.now(); let reqs = 0;
const WAIT = process.env.DK_WAIT_MS === undefined ? {} : { directWaitMs: +process.env.DK_WAIT_MS, proxyWaitMs: +process.env.DK_WAIT_MS };   // test knobs, as in fetch.js
if (process.env.DK_DIRECT_TRIES !== undefined) WAIT.directTries = +process.env.DK_DIRECT_TRIES;
const getDay = async d => {
  if (Date.now() - t0 > BUDGET) return { kind: 'fail' };                     // out of time: leave the day for the next run
  const [y, m, dd] = d.split('-').map(Number); reqs++; const r = await fetchDay(ID, y, m, dd, stat, WAIT);
  if (r.kind === 'none' && recent(d)) return { kind: 'fail' };               // a very recent day without a file is probably not published yet
  return r.kind === 'ok' || r.kind === 'none' ? r : { kind: 'fail' };
};
(async () => {
  const store = storeFor('HUB_WRITER'), pub = new Publisher({ store, sym: SYM, digits: DIGITS });
  const s = await pub.syncDays(dates, getDay);
  console.log(`days: ${dates.length}; skipped (already complete remotely): ${s.skipped}; fetched: ${s.fetched}; failed: ${s.failed.length}${s.failed.length ? ' (' + s.failed.join(',') + ')' : ''}`);
  console.log(`source requests (days): ${reqs}; source stats ${JSON.stringify(stat)}`);
  let published = 0, unchanged = 0, incomplete = [];
  for (const mo of [...months].sort()) {
    const b = await pub.buildMonth(mo);
    if (!b.complete) { incomplete.push(`${mo}(${b.missing.length} missing)`); continue; }
    const r = await pub.publishMonth(mo, b); r.changed ? published++ : unchanged++;
    console.log(`month ${mo}: rows=${b.rows} bytes=${b.bytes.length} ${r.changed ? 'published as v' + r.v : 'unchanged v' + r.v}`);
  }
  console.log(`months published: ${published}, unchanged: ${unchanged}, incomplete: ${incomplete.length ? incomplete.join(' ') : 'none'}`);
  console.log('candidate manifest updated; it is NOT trusted until the sign job runs.');
  if (s.failed.length) process.exitCode = 3;                                 // not an error of the pipeline, but the run is not complete: re-run to resume
})().catch(e => fail((e && e.message) || e));
