'use strict';
// The proxy is an optional fallback. These tests exercise the function level; test/fetch-resume.test.js covers whole runs.
const test = require('node:test'), assert = require('node:assert');
const { GOOD, AMBIENT } = require('./helpers'); for (const k of AMBIENT) delete process.env[k]; // hermetic
const FAST = { directWaitMs: 0, proxyWaitMs: 0 };
const resp = (st, body, hdr) => ({ status: st, ok: st >= 200 && st < 300, headers: { get: k => (hdr || {})[k] || null }, arrayBuffer: async () => body });
const load = () => { delete require.cache[require.resolve('../src/dukascopy')]; return require('../src/dukascopy'); };
const isProxy = u => u.includes('proxy.invalid');

test('no proxy configured: direct success never touches a proxy', async () => {
  delete process.env.DK_PROXY_URL; const dk = load(), calls = [];
  global.fetch = async u => { calls.push(String(u)); return resp(200, GOOD); };
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST);
  assert.strictEqual(r.kind, 'ok'); assert.strictEqual(r.via, 'direct'); assert.ok(calls.every(u => u.includes('datafeed.dukascopy.com')));
});
test('dead proxy configured: direct still works', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load();
  global.fetch = async u => { if (isProxy(String(u))) throw new Error('down'); return resp(200, GOOD); };
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST); assert.strictEqual(r.via, 'direct');
});
test('breaker opens after 3 days with a dead proxy, stats are split per source', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load(), stat = {};
  global.fetch = async u => { if (isProxy(String(u))) throw new Error('down'); return resp(503, Buffer.alloc(0)); };
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(await dk.fetchDay('XAUUSD', 2026, 10, 14 + i, stat, FAST), { kind: 'fail' });
  assert.strictEqual(stat.proxy.breaker_open, 1); assert.ok(stat.direct.http503 >= 12); assert.strictEqual(stat.proxy.error, 9);
  assert.strictEqual(stat.direct.error, undefined); // direct errors and proxy errors are separate
  await dk.fetchDay('XAUUSD', 2026, 10, 20, stat, FAST); assert.strictEqual(stat.proxy.error, 9); assert.strictEqual(stat.proxy.skipped_breaker_open, 1);
});
test('two failed days then a proxy success: counter back to 0, breaker never opens, three more failures needed', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load(), stat = {}; let proxyUp = false;
  global.fetch = async u => { if (isProxy(String(u))) { if (!proxyUp) throw new Error('down'); return resp(200, GOOD, { 'x-upstream-status': '200' }); } return resp(503, Buffer.alloc(0)); };
  await dk.fetchDay('XAUUSD', 2026, 10, 14, stat, FAST); await dk.fetchDay('XAUUSD', 2026, 10, 15, stat, FAST); assert.strictEqual(dk._proxyFailDays(), 2);
  proxyUp = true; const r = await dk.fetchDay('XAUUSD', 2026, 10, 16, stat, FAST);
  assert.strictEqual(r.via, 'proxy'); assert.strictEqual(dk._proxyFailDays(), 0); assert.strictEqual(stat.proxy.breaker_open, undefined);
  proxyUp = false; await dk.fetchDay('XAUUSD', 2026, 10, 17, stat, FAST); await dk.fetchDay('XAUUSD', 2026, 10, 18, stat, FAST);
  assert.strictEqual(dk._proxyFailDays(), 2); assert.strictEqual(stat.proxy.breaker_open, undefined); // needs a fresh run of 3
});
test('proxy attempts 1 and 2 fail, attempt 3 succeeds within one day: no failed day counted', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load(); let n = 0;
  global.fetch = async u => { if (isProxy(String(u))) { if (++n < 3) throw new Error('down'); return resp(200, GOOD, { 'x-upstream-status': '200' }); } return resp(503, Buffer.alloc(0)); };
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST); assert.strictEqual(r.via, 'proxy'); assert.strictEqual(dk._proxyFailDays(), 0);
});
test('a fresh process starts with the proxy enabled (breaker is per process, not persisted)', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; let dk = load();
  global.fetch = async u => { if (isProxy(String(u))) throw new Error('down'); return resp(503, Buffer.alloc(0)); };
  for (let i = 0; i < 3; i++) await dk.fetchDay('XAUUSD', 2026, 10, 14 + i, {}, FAST); assert.strictEqual(dk._proxyFailDays(), 3);
  dk = load(); assert.strictEqual(dk._proxyFailDays(), 0);
});
test('HTTP 200 alone is not enough: undecodable content from direct or proxy is rejected', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load(), stat = {};
  const junk = Buffer.from('<html><body>error page that is long enough</body></html>');
  global.fetch = async u => (isProxy(String(u)) ? resp(200, junk, { 'x-upstream-status': '200' }) : resp(200, junk));
  assert.deepStrictEqual(await dk.fetchDay('XAUUSD', 2026, 10, 14, stat, FAST), { kind: 'fail' });
  assert.ok(stat.direct.invalid_lzma >= 4); assert.ok(stat.proxy.invalid_lzma >= 3);
});
test('proxy: tiny or empty 200 is never recorded as an empty day; only an explicit upstream 404 is', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load();
  global.fetch = async u => (isProxy(String(u)) ? resp(200, Buffer.alloc(3), { 'x-upstream-status': '200' }) : resp(503, Buffer.alloc(0)));
  assert.deepStrictEqual(await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST), { kind: 'fail' });
  global.fetch = async u => (isProxy(String(u)) ? resp(200, Buffer.alloc(0), { 'x-upstream-status': '404' }) : resp(503, Buffer.alloc(0)));
  assert.strictEqual((await dk.fetchDay('XAUUSD', 2026, 10, 15, {}, FAST)).kind, 'none');
});
test('validateDay rejects bad times and bad OHLC', () => {
  const { validateDay } = load(); assert.strictEqual(validateDay(GOOD, 2026, 10, 14).ok, true);
  assert.strictEqual(validateDay(GOOD, 2026, 10, 15).ok, true); // times are offsets from the day start, so any day passes the time check
  const cp = require('child_process'), b = Buffer.alloc(48);
  [[0, 100, 104, 98, 110], [60, 100, 90, 95, 99]].forEach((r, i) => r.forEach((x, j) => b.writeUInt32BE(x, i * 24 + j * 4))); // 2nd row: close 90 below low 95
  const bad = cp.spawnSync('xz', ['--format=lzma', '-zc'], { input: b }).stdout; assert.deepStrictEqual(validateDay(bad, 2026, 10, 14), { ok: false, reason: 'ohlc' });
});
test('upstream failures relayed by the Worker (HTTP 200 + x-upstream-status) are counted under proxy, separately from direct', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; const dk = load(), stat = {};
  global.fetch = async u => (isProxy(String(u)) ? resp(200, Buffer.alloc(0), { 'x-upstream-status': '503' }) : resp(503, Buffer.alloc(0)));
  assert.deepStrictEqual(await dk.fetchDay('XAUUSD', 2026, 10, 14, stat, FAST), { kind: 'fail' });
  assert.strictEqual(stat.proxy.upstream503, 3); assert.strictEqual(stat.proxy.http200, 3); assert.strictEqual(stat.direct.upstream503, undefined);
});
