'use strict';
// Resumable day-file downloader. State lives in work/ (runner disk only, never committed).
// Env: SYM, DKID (default SYM), FROM, TO (YYYY-MM-DD, UTC), BUDGET_SEC (default 600), PASSES (default 3)
const fs = require('fs'), path = require('path');
const { fetchDay } = require('../src/dukascopy');
const SYM = process.env.SYM || 'XAUUSD', ID = process.env.DKID || SYM;
if (!/^[A-Za-z0-9]+$/.test(ID)) { console.error('bad symbol id'); process.exit(2); }
const FROM = process.env.FROM, TO = process.env.TO, BUDGET = +(process.env.BUDGET_SEC || 600) * 1000, PASSES = +(process.env.PASSES || 3);
if (!/^\d{4}-\d\d-\d\d$/.test(FROM || '') || !/^\d{4}-\d\d-\d\d$/.test(TO || '')) { console.error('FROM/TO required'); process.exit(2); }
const WORK = path.join(__dirname, '..', 'work'), RAW = path.join(WORK, 'raw', ID), STATE = path.join(WORK, `state-${ID}.json`);
fs.mkdirSync(RAW, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { days: {}, stat: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const dates = [];
for (let t = Date.parse(FROM + 'T00:00:00Z'); t <= Date.parse(TO + 'T00:00:00Z'); t += 864e5) { const dt = new Date(t); if (dt.getUTCDay() !== 6) dates.push(dt.toISOString().slice(0, 10)); }
const done = d => { const s = state.days[d]; return s && (s.kind === 'none' || (s.kind === 'ok' && fs.existsSync(path.join(RAW, d + '.bi5')))); };
const t0 = Date.now(); let fetched = 0;
const already = dates.filter(done).length;
console.log(`range ${FROM}..${TO}: ${dates.length} candidate days, ${already} already complete (resume)`);
(async () => {
  for (let pass = 1; pass <= PASSES; pass++) {
    const todo = dates.filter(d => !done(d));
    if (!todo.length) break;
    if (pass > 1) { console.log(`pass ${pass}: retrying ${todo.length} failed/missing day(s) after cool-down`); await new Promise(r => setTimeout(r, 20000)); }
    for (const d of todo) {
      if (Date.now() - t0 > BUDGET) { console.log('time budget reached; stopping (state saved)'); pass = PASSES + 1; break; }
      const [y, m, dd] = d.split('-').map(Number);
      const r = await fetchDay(ID, y, m, dd, state.stat);
      state.days[d] = { kind: r.kind, via: r.via || null, tries: ((state.days[d] || {}).tries || 0) + 1, bytes: r.buf ? r.buf.length : 0 };
      if (r.kind === 'ok') fs.writeFileSync(path.join(RAW, d + '.bi5'), r.buf);
      save(); fetched++; console.log(`${d} ${r.kind} via=${r.via || '-'} bytes=${state.days[d].bytes}`);
      await new Promise(r => setTimeout(r, 800));
    }
  }
  const missing = dates.filter(d => !done(d));
  console.log(`fetched this invocation: ${fetched}; complete: ${dates.length - missing.length}/${dates.length}; still missing: ${missing.join(',') || 'none'}`);
  console.log('stats ' + JSON.stringify(state.stat));
})().catch(e => { console.error('FATAL', String(e).slice(0, 200)); process.exit(1); });
