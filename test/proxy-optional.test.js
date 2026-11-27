'use strict';
// The proxy is an optional fallback: the direct download must work with no proxy and with a dead proxy.
const test = require('node:test'), assert = require('node:assert');
const dk = require('../src/dukascopy');
const okBody = Buffer.alloc(40, 7);
function mock(handler) { global.fetch = async (u) => handler(String(u)); }
const resp = (st, body) => ({ status: st, ok: st >= 200 && st < 300, headers: { get: () => null }, arrayBuffer: async () => body });
const FAST = { directWaitMs: 0, proxyWaitMs: 0 };

test('no proxy configured: direct success never touches a proxy', async () => {
  delete process.env.DK_PROXY_URL; dk._resetProxy(); const calls = [];
  mock(u => { calls.push(u); return resp(200, okBody); });
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST);
  assert.strictEqual(r.kind, 'ok'); assert.strictEqual(r.via, 'direct'); assert.ok(calls.every(u => u.includes('datafeed.dukascopy.com')));
});
test('dead proxy configured: direct still works and the proxy is never needed', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; dk._resetProxy();
  mock(u => { if (u.includes('proxy.invalid')) throw new Error('down'); return resp(200, okBody); });
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST);
  assert.strictEqual(r.kind, 'ok'); assert.strictEqual(r.via, 'direct');
});
test('direct throttled and proxy dead: returns fail (retried later), does not throw; breaker disables proxy', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; dk._resetProxy(); const stat = {};
  mock(u => { if (u.includes('proxy.invalid')) throw new Error('down'); return resp(503, Buffer.alloc(0)); });
  for (let i = 0; i < 4; i++) assert.deepStrictEqual(await dk.fetchDay('XAUUSD', 2026, 10, 14 + i, stat, FAST), { kind: 'fail' });
  assert.strictEqual(stat['proxy:disabled'], 1);
  const before = stat['proxy:err']; await dk.fetchDay('XAUUSD', 2026, 10, 20, stat, FAST); assert.strictEqual(stat['proxy:err'], before);
});
test('direct throttled but proxy works: falls back to the proxy', async () => {
  process.env.DK_PROXY_URL = 'https://proxy.invalid'; dk._resetProxy();
  mock(u => (u.includes('proxy.invalid') ? resp(200, okBody) : resp(503, Buffer.alloc(0))));
  const r = await dk.fetchDay('XAUUSD', 2026, 10, 14, {}, FAST); assert.strictEqual(r.via, 'proxy');
});
