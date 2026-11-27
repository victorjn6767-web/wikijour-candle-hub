'use strict';
// Resumable day-file downloader. State lives in work/ (runner disk only, never committed).
// Env: SYM, DKID (default SYM), FROM, TO (YYYY-MM-DD, UTC), BUDGET_SEC (default 600), PASSES (default 3)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { fetchDay } = require('../src/dukascopy');
const SYM = process.env.SYM || 'XAUUSD', ID = process.env.DKID || SYM;
if (!/^[A-Za-z0-9]+$/.test(ID)) { console.error('bad symbol id'); process.exit(2); }
const FROM = process.env.FROM, TO = process.env.TO, BUDGET = +(process.env.BUDGET_SEC || 600) * 1000, PASSES = +(process.env.PASSES || 3);
if (!/^\d{4}-\d\d-\d\d$/.test(FROM || '') || !/^\d{4}-\d\d-\d\d$/.test(TO || '')) { console.error('FROM/TO required'); process.exit(2); }
const WORK = process.env.WORK_DIR || path.join(__dirname, '..', 'work'), RAW = path.join(WORK, 'raw', ID), STATE = path.join(WORK, `state-${ID}.json`);
fs.mkdirSync(RAW, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { days: {}, stat: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const dates = [];
for (let t = Date.parse(FROM + 'T00:00:00Z'); t <= Date.parse(TO + 'T00:00:00Z'); t += 864e5) { const dt = new Date(t); if (dt.getUTCDay() !== 6) dates.push(dt.toISOString().slice(0, 10)); }
const rawPath = d => path.join(RAW, d + '.bi5');
// A day is complete only if it was validated AND the stored file is still intact (size matches what was validated).
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// complete = validated when stored AND the stored file still has exactly the validated content (size and SHA-256)
const done = d => { const s = state.days[d]; if (!s) return false; if (s.kind === 'none') return true; if (s.kind !== 'ok' || !fs.existsSync(rawPath(d))) return false; const b = fs.readFileSync(rawPath(d)); return b.length === s.bytes && sha(b) === s.sha; };
const reqCount = () => { const o = { direct: 0, proxy: 0 }; for (const v of ['direct', 'proxy']) for (const [k, n] of Object.entries(state.stat[v] || {})) if (/^(http\d+|error)$/.test(k)) o[v] += n; return o; };
const TODAY = process.env.DK_TODAY || new Date().toISOString().slice(0, 10), COOL = +(process.env.COOLDOWN_MS ?? 20000), PAUSE = +(process.env.DAY_PAUSE_MS ?? 800);
const WAIT = process.env.DK_WAIT_MS === undefined ? {} : { directWaitMs: +process.env.DK_WAIT_MS, proxyWaitMs: +process.env.DK_WAIT_MS };
const recent = d => Date.parse(TODAY + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z') < 2 * 864e5;
const t0 = Date.now(); let fetched = 0; const reqStart = reqCount();
const already = dates.filter(done).length;
console.log(`range ${FROM}..${TO}: ${dates.length} candidate days, ${already} already complete (resume)`);
(async () => {
  for (let pass = 1; pass <= PASSES; pass++) {
    const todo = dates.filter(d => !done(d));
    if (!todo.length) break;
    if (pass > 1) { console.log(`pass ${pass}: retrying ${todo.length} failed/missing day(s) after cool-down`); await new Promise(r => setTimeout(r, COOL)); }
    for (const d of todo) {
      if (Date.now() - t0 > BUDGET) { console.log('time budget reached; stopping (state saved)'); pass = PASSES + 1; break; }
      const [y, m, dd] = d.split('-').map(Number);
      const q0 = reqCount(); const r = await fetchDay(ID, y, m, dd, state.stat, WAIT); const q1 = reqCount(); const prevR = (state.days[d] || {}).reqs || { direct: 0, proxy: 0 };
      let kind = r.kind; if (kind === 'none' && recent(d)) kind = 'pending'; // a very recent day with no file is probably not published yet
      state.days[d] = { kind, via: r.via || null, tries: ((state.days[d] || {}).tries || 0) + 1, bytes: r.buf ? r.buf.length : 0, rows: r.rows || 0, sha: r.buf ? sha(r.buf) : null, reqs: { direct: prevR.direct + q1.direct - q0.direct, proxy: prevR.proxy + q1.proxy - q0.proxy } };
      if (kind === 'ok') { fs.writeFileSync(rawPath(d) + '.tmp', r.buf); fs.renameSync(rawPath(d) + '.tmp', rawPath(d)); }
      save(); fetched++; console.log(`${d} ${kind} via=${r.via || '-'} bytes=${state.days[d].bytes}`);
      await new Promise(r => setTimeout(r, PAUSE));
    }
  }
  const missing = dates.filter(d => !done(d));
  console.log(`fetched this invocation: ${fetched}; complete: ${dates.length - missing.length}/${dates.length}; still missing: ${missing.join(',') || 'none'}`);
  const rq = reqCount(); console.log(`requests this invocation: direct=${rq.direct - reqStart.direct} proxy=${rq.proxy - reqStart.proxy}; elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('stats ' + JSON.stringify(state.stat));
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
