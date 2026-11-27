'use strict';
// Dukascopy public M1 day files: BID_candles_min_1.bi5 (LZMA-alone compressed, 24-byte big-endian records).
const cp = require('child_process');
const pad = n => String(n).padStart(2, '0');

// m is 1-based here; Dukascopy paths use a 0-based month.
function dayUrl(id, y, m, d) {
  return `https://datafeed.dukascopy.com/datafeed/${id}/${y}/${pad(m - 1)}/${pad(d)}/BID_candles_min_1.bi5`;
}

function lzmaDecode(buf) {
  const r = cp.spawnSync('xz', ['--format=lzma', '-dc'], { input: buf, maxBuffer: 1 << 28, timeout: 30000 });
  if (r.error) throw r.error;
  const out = r.stdout || Buffer.alloc(0);
  if (!out.length) throw new Error('lzma: empty output');
  return out;
}

// Record: u32 seconds since day start, u32 open, u32 close, u32 low, u32 high, f32 volume (all big-endian).
function parseDay(raw, dayStartSec) {
  if (raw.length % 24) throw new Error('bad length ' + raw.length);
  const n = raw.length / 24, v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = i * 24;
    rows[i] = { t: dayStartSec + v.getUint32(r), o: v.getUint32(r + 4), c: v.getUint32(r + 8), l: v.getUint32(r + 12), h: v.getUint32(r + 16), v: v.getFloat32(r + 20) };
  }
  return rows;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bump = (s, k) => { s[k] = (s[k] || 0) + 1; };

async function once(url, via, stat) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 candle-hub' }, signal: AbortSignal.timeout(20000) });
  bump(stat, via + ':' + r.status);
  if (r.status === 404) return { kind: 'none' };
  if (via === 'proxy') {
    const up = r.headers.get('x-upstream-status');
    if (up && up !== '200') { bump(stat, 'proxy:up' + up); return up === '404' ? { kind: 'none' } : { kind: 'retry' }; }
  }
  if (!r.ok) return { kind: 'retry' };
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length < 13 ? { kind: 'none' } : { kind: 'ok', buf };
}

// Direct first (backoff), then an optional pass-through proxy given by env DK_PROXY_URL (a repository secret).
// Returns {kind:'ok',buf,via} | {kind:'none'} | {kind:'fail'}. Never logs the proxy address.
async function fetchDay(id, y, m, d, stat, opt = {}) {
  const proxy = process.env.DK_PROXY_URL || '';
  for (let k = 0; k < (opt.directTries || 4); k++) {
    try { const r = await once(dayUrl(id, y, m, d), 'direct', stat); if (r.kind !== 'retry') return Object.assign(r, { via: 'direct' }); }
    catch (e) { bump(stat, 'direct:err'); }
    await sleep(1500 * Math.pow(2, k));
  }
  if (proxy) {
    for (let k = 0; k < 3; k++) {
      try { const r = await once(`${proxy}/raw?i=${id}&tf=m1&side=bid&y=${y}&m=${m}&d=${d}`, 'proxy', stat); if (r.kind !== 'retry') return Object.assign(r, { via: 'proxy' }); }
      catch (e) { bump(stat, 'proxy:err'); }
      await sleep(1500 * (k + 1));
    }
  }
  return { kind: 'fail' };
}

module.exports = { dayUrl, lzmaDecode, parseDay, fetchDay };
