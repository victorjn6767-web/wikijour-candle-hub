'use strict';
// Dukascopy public M1 day files: BID_candles_min_1.bi5 (LZMA-alone compressed, 24-byte big-endian records).
const cp = require('child_process');
const pad = n => String(n).padStart(2, '0');

// DK_BASE exists for tests only (local mock server). m is 1-based; Dukascopy paths use a 0-based month.
const base = () => process.env.DK_BASE || 'https://datafeed.dukascopy.com/datafeed';
function dayUrl(id, y, m, d) { return `${base()}/${id}/${y}/${pad(m - 1)}/${pad(d)}/BID_candles_min_1.bi5`; }

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

// A download only counts as complete if the bytes decode AND the candles are sane.
function validateDay(buf, y, m, d) {
  let raw; try { raw = lzmaDecode(buf); } catch (e) { return { ok: false, reason: 'lzma' }; }
  const t0 = Date.UTC(y, m - 1, d) / 1e3; let rows; try { rows = parseDay(raw, t0); } catch (e) { return { ok: false, reason: 'length' }; }
  if (!rows.length || rows.length > 1440) return { ok: false, reason: 'count' };
  let prev = -1;
  for (const k of rows) {
    if (k.t % 60 || k.t < t0 || k.t >= t0 + 86400 || k.t <= prev) return { ok: false, reason: 'time' }; prev = k.t;
    if (!(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0) || !(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c)) || !(k.v >= 0)) return { ok: false, reason: 'ohlc' };
  }
  return { ok: true, rows: rows.length };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Statistics are kept per source so that direct and proxy problems are never mixed.
const bump = (stat, via, key) => { stat[via] = stat[via] || {}; stat[via][key] = (stat[via][key] || 0) + 1; };

// Circuit breaker for the optional proxy. It lives in this process only: every new process (every workflow
// step and every workflow run) starts with the proxy enabled. It is never written to the state file.
let proxyFailDays = 0; const PROXY_MAX_FAIL_DAYS = 3;

async function once(url, via, stat) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 candle-hub' }, signal: AbortSignal.timeout(20000) });
  bump(stat, via, 'http' + r.status);
  if (via === 'direct') {
    if (r.status === 404) return { kind: 'none' };
    if (!r.ok) return { kind: 'retry' };
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length < 13 ? { kind: 'none' } : { kind: 'ok', buf };
  }
  // proxy: only an explicit upstream 404 means "no file"; anything odd is a retry, never an authoritative empty day
  const up = r.headers.get('x-upstream-status');
  if (up && up !== '200') bump(stat, 'proxy', 'upstream' + up); // the Worker relays upstream failures as HTTP 200 plus this header
  if (up === '404') return { kind: 'none' };
  if (!r.ok || (up && up !== '200')) return { kind: 'retry' };
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length < 13 ? { kind: 'retry' } : { kind: 'ok', buf };
}

// Returns {kind:'ok',buf,rows,via} | {kind:'none',via} | {kind:'fail'}.
async function fetchDay(id, y, m, d, stat, opt = {}) {
  const accept = (r, via) => {
    if (r.kind !== 'ok') return r;
    const v = validateDay(r.buf, y, m, d);
    if (v.ok) { r.rows = v.rows; return r; }
    bump(stat, via, 'invalid_' + v.reason); return { kind: 'retry' };
  };
  for (let k = 0; k < (opt.directTries || 4); k++) {
    try { const r = accept(await once(dayUrl(id, y, m, d), 'direct', stat), 'direct'); if (r.kind !== 'retry') return Object.assign(r, { via: 'direct' }); }
    catch (e) { bump(stat, 'direct', 'error'); }
    await sleep(opt.directWaitMs === undefined ? 1500 * Math.pow(2, k) : opt.directWaitMs);
  }
  const proxy = process.env.DK_PROXY_URL || '';
  if (proxy && proxyFailDays < PROXY_MAX_FAIL_DAYS) {
    for (let k = 0; k < 3; k++) {
      try {
        const r = accept(await once(`${proxy}/raw?i=${id}&tf=m1&side=bid&y=${y}&m=${m}&d=${d}`, 'proxy', stat), 'proxy');
        if (r.kind !== 'retry') { proxyFailDays = 0; return Object.assign(r, { via: 'proxy' }); }
      } catch (e) { bump(stat, 'proxy', 'error'); }
      await sleep(opt.proxyWaitMs === undefined ? 1500 * (k + 1) : opt.proxyWaitMs);
    }
    proxyFailDays++; // one more day on which every proxy attempt failed (a success above resets this to 0)
    if (proxyFailDays === PROXY_MAX_FAIL_DAYS) bump(stat, 'proxy', 'breaker_open');
  } else if (proxy) bump(stat, 'proxy', 'skipped_breaker_open');
  return { kind: 'fail' };
}

module.exports = { dayUrl, lzmaDecode, parseDay, validateDay, fetchDay, _proxyFailDays: () => proxyFailDays, _resetProxy: () => { proxyFailDays = 0; } };
