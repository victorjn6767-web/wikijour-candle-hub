'use strict';
// Manifest: strict schema, hard size limits, paths are DERIVED (never taken from the manifest) so a manifest cannot point outside fx/.
const LIM = { manifest: 256 * 1024, file: 1024 * 1024, decoded: 16 * 1024 * 1024, rowsPerMonth: 44640, symbols: 64, months: 400 };
const SYM = /^[A-Z0-9]{3,12}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, HEX = /^[0-9a-f]{64}$/;
const monthPath = (sym, month, v) => `fx/${sym}/${month}.v${v}.m1.gz`;
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
const serialize = m => Buffer.from(JSON.stringify(sortKeys(m)) + '\n');
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
function parse(bytes) {
  if (bytes.length > LIM.manifest) throw new Error('manifest too large');
  let m; try { m = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new Error('manifest is not JSON'); }
  if (!isObj(m) || m.schema !== 1 || !int(m.seq, 1, 2 ** 40) || typeof m.generated !== 'string' || isNaN(Date.parse(m.generated))) throw new Error('bad manifest header');
  if (!isObj(m.symbols) || Object.keys(m.symbols).length > LIM.symbols) throw new Error('bad symbols');
  for (const [sym, s] of Object.entries(m.symbols)) {
    if (!SYM.test(sym) || !isObj(s) || s.side !== 'bid' || !int(s.digits, 0, 8) || !isObj(s.months) || Object.keys(s.months).length > LIM.months) throw new Error('bad symbol ' + sym);
    for (const [mo, e] of Object.entries(s.months)) {
      if (!MONTH.test(mo) || !isObj(e) || !int(e.v, 1, 1e9) || !int(e.bytes, 1, LIM.file) || !HEX.test(e.sha256) || !int(e.rows, 0, LIM.rowsPerMonth) || !int(e.firstMin, 0, 2 ** 31) || !int(e.lastMin, 0, 2 ** 31) || e.lastMin < e.firstMin) throw new Error(`bad month entry ${sym} ${mo}`);
    }
  }
  return m;
}
module.exports = { LIM, monthPath, serialize, parse };
