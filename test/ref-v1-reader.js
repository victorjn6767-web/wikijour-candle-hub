'use strict';
// Independent reference reader for WJM1 version 1, written from the format description only (does not import src/wjm1.js).
// Layout (after gunzip): "WJM1" | version u8 | digits u8 | count u32 LE | firstMinute u32 LE (minutes since 2000-01-01 UTC)
// then six varint columns of `count` values each: dt, o, dh, dl, dc, v; then run count + (code, length) pairs.
// Varints are little-endian base-128. o and dc are zig-zag; o is the delta from the previous close; v is the raw float32 bit pattern.
const zlib = require('zlib');
function readV1(gz) {
  const b = zlib.gunzipSync(gz);
  if (b.slice(0, 4).toString('latin1') !== 'WJM1' || b[4] !== 1) throw new Error('not WJM1 v1');
  const n = b.readUInt32LE(6), firstMin = b.readUInt32LE(10); let p = 14;
  const vi = () => { let v = 0n, sh = 0n; for (;;) { const x = b[p++]; v |= BigInt(x & 127) << sh; if (!(x & 128)) break; sh += 7n; } return Number(v); };
  const col = () => Array.from({ length: n }, vi);
  const dt = col(), o = col(), dh = col(), dl = col(), dc = col(), v = col();
  const un = z => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);
  const out = []; let minutes = firstMin, prevClose = 0; const fb = Buffer.alloc(4);
  for (let i = 0; i < n; i++) {
    minutes += i === 0 ? 0 : dt[i]; const open = prevClose + un(o[i]); const close = open + un(dc[i]); prevClose = close;
    fb.writeUInt32LE(v[i]); out.push({ t: 946684800 + minutes * 60, o: open, h: open + dh[i], l: open - dl[i], c: close, v: fb.readFloatLE(0) });
  }
  const runs = []; const rc = vi(); for (let i = 0; i < rc; i++) runs.push([vi(), vi()]);
  if (p !== b.length) throw new Error('trailing bytes');
  return { version: b[4], digits: b[5], count: n, rows: out, runs };
}
module.exports = { readV1 };
