'use strict';
// Decode the downloaded day files, validate, classify filler candles, check sessions/DST, measure encodings.
// Prints aggregate statistics only (no candle values). Env: SYM, DKID, FROM, TO, DIGITS (default 3)
const fs = require('fs'), path = require('path');
const { lzmaDecode, parseDay, validateDay } = require('../src/dukascopy');
const { readV1 } = require('../test/ref-v1-reader');
const crypto = require('crypto');
const { encode, decode } = require('../src/wjm1');
const SYM = process.env.SYM || 'XAUUSD', ID = process.env.DKID || SYM;
if (!/^[A-Za-z0-9]+$/.test(ID)) { console.error('bad symbol id'); process.exit(2); }
const DIGITS = +(process.env.DIGITS || 3);
const FROM = process.env.FROM, TO = process.env.TO;
const WORK = process.env.WORK_DIR || path.join(__dirname, '..', 'work'), RAW = path.join(WORK, 'raw', ID), STATE = path.join(WORK, `state-${ID}.json`);
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const iso = t => new Date(t * 1000).toISOString().slice(0, 16) + 'Z';
const hm = t => new Date(t * 1000).toISOString().slice(11, 16);
const rep = { sym: SYM, from: FROM, to: TO, checks: {} }, c = rep.checks;
const dates = []; for (let t = Date.parse(FROM + 'T00:00:00Z'); t <= Date.parse(TO + 'T00:00:00Z'); t += 864e5) { const dt = new Date(t); if (dt.getUTCDay() !== 6) dates.push(dt.toISOString().slice(0, 10)); }
const rows = [], byDay = {}, missing = [], none = [];
let badDay = 0, rawBytes = {};
for (const d of dates) {
  const s = state.days[d];
  if (!s) { missing.push(d); continue; } if (s.kind === 'none') { none.push(d); continue; } if (s.kind !== 'ok') { missing.push(d); continue; }
  const [y, m, dd] = d.split('-').map(Number), base = Date.UTC(y, m - 1, dd) / 1e3;
  let r; try { r = parseDay(lzmaDecode(fs.readFileSync(path.join(RAW, d + '.bi5'))), base); } catch (e) { badDay++; missing.push(d); continue; }
  byDay[d] = r.length; rawBytes[d.slice(0, 7)] = (rawBytes[d.slice(0, 7)] || 0) + s.bytes;
  for (const k of r) { k.day = d; rows.push(k); }
}
rows.sort((a, b) => a.t - b.t);
c.days = { expected: dates.length, with_data: Object.keys(byDay).length, no_file_404_or_empty: none, missing_after_all_retries: missing, undecodable: badDay };
c.rows = rows.length;
let dup = 0, off = 0, outDay = 0, ohlc = 0, nonpos = 0; const seen = new Set();
for (let i = 0; i < rows.length; i++) {
  const k = rows[i]; if (seen.has(k.t)) dup++; seen.add(k.t); if (k.t % 60) off++;
  const ds = Date.parse(k.day + 'T00:00:00Z') / 1e3; if (k.t < ds || k.t >= ds + 86400) outDay++;
  if (!(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c))) ohlc++; if (!(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0)) nonpos++;
}
Object.assign(c, { duplicates: dup, off_minute_grid: off, outside_own_day: outDay, ohlc_violations: ohlc, nonpositive_prices: nonpos });
// ---- filler classification
const flat = k => k.o === k.h && k.h === k.l && k.l === k.c, filler = k => flat(k) && k.v === 0;
let fl = 0, flatVol = 0, zeroNonFlat = 0; for (const k of rows) { if (filler(k)) fl++; else if (flat(k)) flatVol++; if (k.v === 0 && !flat(k)) zeroNonFlat++; }
c.filler = { flat_and_zero_volume: fl, flat_with_volume: flatVol, zero_volume_not_flat: zeroNonFlat, share: rows.length ? +(fl / rows.length).toFixed(4) : 0 };
const real = rows.filter(k => !filler(k)); c.non_filler_rows = real.length;
// ---- volume quantisation (is volume k/1e5 exactly reproducible as float32?)
let q = 0, nq = 0, vmax = 0; for (const k of real) { const kk = Math.round(k.v * 1e5); if (Math.fround(kk / 1e5) === k.v) q++; else nq++; vmax = Math.max(vmax, k.v); }
c.volume = { rows_checked: real.length, exactly_k_over_1e5: q, not_reproducible: nq, max: +vmax.toFixed(5), integer_valued: real.filter(k => Number.isInteger(k.v)).length };
// ---- sessions / DST: filler runs >= 20 min per UTC date
const sess = {}, sigs = {};
for (const d of Object.keys(byDay)) {
  const day = rows.filter(k => k.day === d), runs = []; let st = null, prev = null;
  for (const k of day) { if (filler(k)) { if (st === null) st = k.t; prev = k.t; } else { if (st !== null && (prev - st) / 60 + 1 >= 20) runs.push([st, prev + 60]); st = null; } }
  if (st !== null && (prev - st) / 60 + 1 >= 20) runs.push([st, prev + 60]);
  const wd = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
  sess[d] = 'wd' + wd + ' ' + (runs.map(r => hm(r[0]) + '-' + hm(r[1] - 0)).join(' ') || 'no closed runs');
  const s = sess[d].replace(/^wd\d /, '(' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd] + ') '); (sigs[s] = sigs[s] || []).push(d);
}
rep.sessions_by_date = sess; rep.session_signatures = Object.fromEntries(Object.entries(sigs).map(([k, v]) => [k, v[0] + '..' + v[v.length - 1] + ' (' + v.length + ' days)']));
// ---- encodings per UTC month
rep.months = {}; let allOk = true;
const months = [...new Set(rows.map(k => k.day.slice(0, 7)))];
for (const mo of months) {
  const mr = rows.filter(k => k.day.startsWith(mo)), mn = mr.filter(k => !filler(k));
  const e1 = encode(mr, DIGITS, 1), e1d = encode(mn, DIGITS, 1), e2 = encode(mn, DIGITS, 2);
  const same = (a, b) => a.length === b.length && a.every((k, i) => k.t === b[i].t && k.o === b[i].o && k.h === b[i].h && k.l === b[i].l && k.c === b[i].c && Math.fround(k.v) === b[i].v);
  let g1 = false, ghdr = null; try { const gr = readV1(e1); ghdr = { version: gr.version, digits: gr.digits, count: gr.count }; g1 = gr.count === mr.length && same(mr, gr.rows) && gr.version === 1 && gr.digits === DIGITS; } catch (e) { g1 = false; }
  const r1 = same(mr, decode(e1).rows), r1d = same(mn, decode(e1d).rows), r2 = same(mn, decode(e2).rows);
  allOk = allOk && r1 && r1d && g1 && (nq ? true : r2);
  rep.months[mo] = { rows_all: mr.length, rows_without_filler: mn.length, source_bi5_bytes: rawBytes[mo] || 0, v1_all_rows_gz: e1.length, v1_without_filler_gz: e1d.length, v2_candidate_without_filler_gz: e2.length, roundtrip_v1_all: r1, independent_v1_reader_matches: g1, v1_header: ghdr, roundtrip_v1_without_filler: r1d, roundtrip_v2_candidate: r2 };
}
rep.all_roundtrips_ok = allOk;
// every complete day must still revalidate from the stored file and match its recorded hash; no orphan files
let revalid = 0, revalBad = [], orphans = [];
for (const d of dates) { const s = state.days[d]; if (!s || s.kind !== 'ok') continue; const b = fs.readFileSync(path.join(RAW, d + '.bi5')); const [y, m, dd] = d.split('-').map(Number); const v = validateDay(b, y, m, dd); if (v.ok && b.length === s.bytes && crypto.createHash('sha256').update(b).digest('hex') === s.sha && v.rows === s.rows) revalid++; else revalBad.push(d); }
for (const f of fs.readdirSync(RAW)) { const d = f.replace(/\.bi5.*$/, ''); if (!state.days[d] || state.days[d].kind !== 'ok' || !f.endsWith('.bi5')) orphans.push(f); }
rep.stored_files_integrity = { complete_days_revalidated: revalid, failed_revalidation: revalBad, orphan_or_partial_files: orphans };
if (revalBad.length || orphans.length) allOk = false;
// fetch statistics, direct and proxy kept apart
const bySrc = {}, tries = {}; for (const d of Object.keys(state.days)) { const s = state.days[d]; if (s.kind === 'ok') bySrc[s.via || '?'] = (bySrc[s.via || '?'] || 0) + 1; tries[s.tries] = (tries[s.tries] || 0) + 1; }
rep.fetch = { direct: state.stat.direct || {}, proxy: state.stat.proxy || {}, complete_days_by_source: bySrc, days_by_number_of_fetch_attempts: tries, pending_days: Object.keys(state.days).filter(d => state.days[d].kind === 'pending'), failed_days_now: Object.keys(state.days).filter(d => state.days[d].kind === 'fail') };
rep.pass = dup === 0 && off === 0 && outDay === 0 && ohlc === 0 && nonpos === 0 && allOk && badDay === 0;
console.log(JSON.stringify(rep, null, 1));
