'use strict';
// CI helper. `snapshot` copies the state file; `compare` checks what happened since: complete days must not have been requested
// again (per-day request counters unchanged), except the days listed in TAMPERED which must have been fetched again and be complete.
const fs = require('fs'), path = require('path');
const ID = process.env.DKID || process.env.SYM || 'XAUUSD'; if (!/^[A-Za-z0-9]+$/.test(ID)) { console.error('bad symbol id'); process.exit(2); };
const WORK = process.env.WORK_DIR || path.join(__dirname, '..', 'work'), STATE = path.join(WORK, `state-${ID}.json`), SNAP = path.join(WORK, `snap-${ID}.json`);
if (process.argv[2] === 'snapshot') { fs.copyFileSync(STATE, SNAP); console.log('snapshot saved'); process.exit(0); }
const a = JSON.parse(fs.readFileSync(SNAP, 'utf8')), b = JSON.parse(fs.readFileSync(STATE, 'utf8')), tam = new Set((process.env.TAMPERED || '').split(',').filter(Boolean));
const tot = r => (r ? r.direct + r.proxy : 0), res = { complete_before: 0, untouched_complete_days: 0, refetched_wrongly: [], newly_completed: 0, tampered_refetched: [], tampered_not_refetched: [], still_not_complete: [] };
for (const d of Object.keys(b.days)) {
  const before = a.days[d], after = b.days[d], was = before && (before.kind === 'ok' || before.kind === 'none');
  if (was && !tam.has(d)) { res.complete_before++; if (tot(after.reqs) === tot(before.reqs) && after.sha === before.sha && after.kind === before.kind) res.untouched_complete_days++; else res.refetched_wrongly.push(d); }
  if (tam.has(d)) { if (tot(after.reqs) > tot(before.reqs) && after.kind === 'ok') res.tampered_refetched.push(d); else res.tampered_not_refetched.push(d); }
  if (!was && after.kind === 'ok') res.newly_completed++;
  if (after.kind !== 'ok' && after.kind !== 'none') res.still_not_complete.push(d);
}
res.pass = !res.refetched_wrongly.length && !res.tampered_not_refetched.length && res.tampered_refetched.length === tam.size;
console.log(JSON.stringify(res)); if (!res.pass) process.exit(1);
