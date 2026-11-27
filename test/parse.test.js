'use strict';
const test = require('node:test'), assert = require('node:assert');
const { parseDay, dayUrl } = require('../src/dukascopy');
test('dayUrl uses a 0-based month', () => {
  assert.strictEqual(dayUrl('XAUUSD', 2026, 10, 14), 'https://datafeed.dukascopy.com/datafeed/XAUUSD/2026/09/14/BID_candles_min_1.bi5');
});
test('parseDay reads time, open, close, low, high, volume', () => {
  const b = Buffer.alloc(48);
  [[0, 100, 104, 98, 110, 0.5], [60, 104, 104, 104, 104, 0]].forEach((r, i) => {
    b.writeUInt32BE(r[0], i * 24); b.writeUInt32BE(r[1], i * 24 + 4); b.writeUInt32BE(r[2], i * 24 + 8);
    b.writeUInt32BE(r[3], i * 24 + 12); b.writeUInt32BE(r[4], i * 24 + 16); b.writeFloatBE(r[5], i * 24 + 20);
  });
  const rows = parseDay(b, 1000);
  assert.deepStrictEqual(rows[0], { t: 1000, o: 100, c: 104, l: 98, h: 110, v: 0.5 });
  assert.strictEqual(rows[1].t, 1060);
  assert.throws(() => parseDay(Buffer.alloc(25), 0), /bad length/);
});
