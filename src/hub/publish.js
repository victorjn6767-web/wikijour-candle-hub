'use strict';
// Writer side (GitHub Actions). Raw day files are content-addressed and immutable; month files are immutable versions; the manifest is
// built as a CANDIDATE by the upload job and only signed+published by the separate signing step.
const { lzmaDecode, parseDay, validateDay } = require('../dukascopy');
const { encode } = require('../wjm1');
const { serialize, parse, monthPath, LIM } = require('./manifest');
const { sign, sha256 } = require('./sign');
const EPOCH = 946684800, CAND = 'candidate/manifest.json';
const dayName = (sym, d, sha) => `raw/${sym}/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}.${sha.slice(0, 16)}.bi5`;
class Publisher {
  constructor({ store, sym, digits }) { this.s = store; this.sym = sym; this.digits = digits; this.state = null; }
  async load() { const b = await this.s.get('hub-raw', `state/${this.sym}.json`); this.state = b ? JSON.parse(b.toString('utf8')) : { days: {} }; return this.state; }
  async save() { await this.s.put('hub-raw', `state/${this.sym}.json`, Buffer.from(JSON.stringify(this.state)), { upsert: true }); }
  // fetchDay(date) -> { kind:'ok', buf } | { kind:'none' } | { kind:'fail' }. Returns { fetched, skipped, failed }.
  async syncDays(dates, fetchDay) {
    if (!this.state) await this.load();
    const have = new Set(), seen = new Set();
    for (const d of dates) { const pre = `raw/${this.sym}/${d.slice(0, 4)}/${d.slice(5, 7)}`; if (seen.has(pre)) continue; seen.add(pre); for (const o of await this.s.list('hub-raw', pre)) have.add(`${pre}/${o.name}`); }
    const out = { fetched: 0, skipped: 0, failed: [] };
    for (const d of dates) {
      const st = this.state.days[d];
      if (st && st.kind === 'none') { out.skipped++; continue; }
      if (st && st.kind === 'ok' && have.has(st.name)) { out.skipped++; continue; }   // complete: validated earlier AND object still exists remotely
      const r = await fetchDay(d); out.fetched++;
      if (r.kind === 'none') { this.state.days[d] = { kind: 'none' }; continue; }
      const [y, m, dd] = d.split('-').map(Number);
      if (r.kind !== 'ok' || !validateDay(r.buf, y, m, dd).ok) { this.state.days[d] = { kind: 'fail' }; out.failed.push(d); continue; }
      const sha = sha256(r.buf), name = dayName(this.sym, d, sha);
      try { await this.s.put('hub-raw', name, r.buf); }
      catch (e) {
        let okRepair = false;
        if (e.status === 409) {                                   // name already taken: fine if identical, otherwise repair (delete the corrupt object, write again)
          const x = await this.s.get('hub-raw', name).catch(() => null);
          if (x && sha256(x) === sha) okRepair = true;
          else { try { await this.s.del('hub-raw', name); await this.s.put('hub-raw', name, r.buf); okRepair = true; } catch (e2) { okRepair = false; } }
        }
        if (!okRepair) { this.state.days[d] = { kind: 'fail' }; out.failed.push(d); continue; }
      }
      this.state.days[d] = { kind: 'ok', name, sha, bytes: r.buf.length };
    }
    await this.save(); return out;
  }
  // Build one month from stored raw days. Complete only if every non-Saturday date of the month is ok/none. Corrupt remote days are demoted to 'fail'.
  async buildMonth(month) {
    const [y, m] = month.split('-').map(Number), n = new Date(Date.UTC(y, m, 0)).getUTCDate(), rows = [], missing = [];
    for (let day = 1; day <= n; day++) {
      const d = `${month}-${String(day).padStart(2, '0')}`; if (new Date(d + 'T00:00:00Z').getUTCDay() === 6) continue;
      const st = this.state.days[d]; if (!st || (st.kind !== 'ok' && st.kind !== 'none')) { missing.push(d); continue; }
      if (st.kind === 'none') continue;
      const b = await this.s.get('hub-raw', st.name);
      if (!b || sha256(b) !== st.sha || !validateDay(b, y, m, day).ok) { this.state.days[d] = { kind: 'fail' }; missing.push(d); continue; }
      for (const k of parseDay(lzmaDecode(b), Date.UTC(y, m - 1, day) / 1e3)) rows.push(k);
    }
    if (missing.length) { await this.save(); return { complete: false, missing }; }
    const bytes = encode(rows, this.digits, 1);
    return { complete: true, bytes, rows: rows.length, firstMin: rows.length ? (rows[0].t - EPOCH) / 60 : 0, lastMin: rows.length ? (rows[rows.length - 1].t - EPOCH) / 60 : 0 };
  }
  async candidate() { const b = await this.s.get('hub-raw', CAND); return b ? parse(b) : { schema: 1, seq: 1, generated: new Date(0).toISOString(), symbols: {} }; }
  // Upload a built month as a new immutable version (skipped when identical to the current one) and record it in the candidate manifest.
  async publishMonth(month, built) {
    const cand = await this.candidate(), s = cand.symbols[this.sym] || (cand.symbols[this.sym] = { side: 'bid', digits: this.digits, months: {} }), prev = s.months[month], sha = sha256(built.bytes);
    if (prev && prev.sha256 === sha) return { changed: false, v: prev.v };
    const v = prev ? prev.v + 1 : 1;
    if (built.bytes.length > LIM.file) throw new Error('month file too large');
    await this.s.put('hub', monthPath(this.sym, month, v), built.bytes);
    const back = await this.s.get('hub', monthPath(this.sym, month, v), LIM.file); if (!back || sha256(back) !== sha) throw new Error('read-back verification failed');
    s.months[month] = { v, bytes: built.bytes.length, sha256: sha, rows: built.rows, firstMin: built.firstMin, lastMin: built.lastMin };
    await this.s.put('hub-raw', CAND, serialize(cand), { upsert: true }); return { changed: true, v };
  }
}
// Signing step (separate job/environment): promotes the candidate to the signed, published manifest. Never runs in the upload job.
async function finalize({ store, privatePem, now = () => new Date() }) {
  const cb = await store.get('hub-raw', CAND); if (!cb) throw new Error('no candidate manifest');
  const cand = parse(cb), cur = await store.get('hub', 'manifest.json'); let seq = 1;
  if (cur) { try { seq = parse(cur).seq + 1; } catch (e) { throw new Error('published manifest unreadable; refusing to guess the sequence'); } }
  const bytes = serialize(Object.assign({}, cand, { seq, generated: now().toISOString() }));
  parse(bytes);                                                  // never sign something the reader would reject
  const sig = sign(bytes, privatePem);
  await store.put('hub', 'manifest.json', bytes, { upsert: true }); await store.put('hub', 'manifest.sig', sig, { upsert: true });
  return { seq };
}
// Keep the two newest versions of each month file; the manifest only ever points at the newest.
async function gc({ store, manifestBytes }) {
  const m = parse(manifestBytes); let deleted = 0;
  for (const [sym, s] of Object.entries(m.symbols)) {
    const files = await store.list('hub', `fx/${sym}`);
    for (const f of files) { const mm = /^(\d{4}-\d{2})\.v(\d+)\.m1\.gz$/.exec(f.name); if (!mm) continue; const cur = s.months[mm[1]]; if (cur && +mm[2] < cur.v - 1) { await store.del('hub', `fx/${sym}/${f.name}`); deleted++; } }
  }
  return { deleted };
}
module.exports = { Publisher, finalize, gc, dayName };
