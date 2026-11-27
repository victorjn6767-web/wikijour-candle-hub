'use strict';
// Month file codec. Version 1 is FROZEN (see test/v1-frozen.test.js). Version 2 is a candidate, measured only.
const zlib = require('zlib');
const EPOCH2000 = 946684800;
const zz = n => (n >= 0 ? n * 2 : -n * 2 - 1), uz = z => (z % 2 ? -(z + 1) / 2 : z / 2);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

function putVar(out, n) { n = Math.floor(n); while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); }
function reader(buf, p) { return () => { let r = 0, m = 1, b; do { b = buf[p++]; r += (b & 127) * m; m *= 128; } while (b & 128); return r; }; }

// rows: sorted [{t,o,h,l,c,v}] with integer prices (scaled by 10^digits) and float32 volume.
// runs: [[sourceCode, length], ...] (default one run of code 0 covering all rows).
function encode(rows, digits, version, runs) {
  version = version || 1;
  const n = rows.length, out = [];
  const hdr = Buffer.alloc(14); hdr.write('WJM1', 0, 'latin1'); hdr[4] = version; hdr[5] = digits;
  hdr.writeUInt32LE(n, 6); hdr.writeUInt32LE(n ? (rows[0].t - EPOCH2000) / 60 : 0, 10);
  const cols = { dt: [], o: [], dh: [], dl: [], dc: [], v: [] };
  let pt = n ? rows[0].t : 0, pc = 0;
  for (const k of rows) {
    cols.dt.push((k.t - pt) / 60); pt = k.t; cols.o.push(zz(k.o - pc)); pc = k.c;
    cols.dh.push(k.h - k.o); cols.dl.push(k.o - k.l); cols.dc.push(zz(k.c - k.o));
    if (version === 1) { f32[0] = k.v; cols.v.push(u32[0]); } else cols.v.push(Math.round(k.v * 1e5));
  }
  for (const nm of ['dt', 'o', 'dh', 'dl', 'dc', 'v']) for (const x of cols[nm]) putVar(out, x);
  runs = runs || [[0, n]]; putVar(out, runs.length); for (const [c, l] of runs) { putVar(out, c); putVar(out, l); }
  return zlib.gzipSync(Buffer.concat([hdr, Buffer.from(out)]), { level: 9 });
}

function decode(gz) {
  const buf = zlib.gunzipSync(gz);
  if (buf.toString('latin1', 0, 4) !== 'WJM1') throw new Error('bad magic');
  const version = buf[4], digits = buf[5], n = buf.readUInt32LE(6), first = buf.readUInt32LE(10) * 60 + EPOCH2000;
  if (version !== 1 && version !== 2) throw new Error('unsupported version ' + version);
  const rd = reader(buf, 14), col = {};
  for (const nm of ['dt', 'o', 'dh', 'dl', 'dc', 'v']) { col[nm] = new Array(n); for (let i = 0; i < n; i++) col[nm][i] = rd(); }
  const rows = new Array(n); let t = first, pc = 0;
  for (let i = 0; i < n; i++) {
    t = i ? t + col.dt[i] * 60 : first; const o = pc + uz(col.o[i]); const c = o + uz(col.dc[i]); pc = c;
    let v; if (version === 1) { u32[0] = col.v[i]; v = f32[0]; } else { f32[0] = col.v[i] / 1e5; v = f32[0]; }
    rows[i] = { t, o, h: o + col.dh[i], l: o - col.dl[i], c, v };
  }
  const rc = rd(), runs = []; for (let i = 0; i < rc; i++) runs.push([rd(), rd()]);
  return { version, digits, rows, runs };
}
module.exports = { encode, decode };
