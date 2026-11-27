'use strict';
const test = require('node:test'), assert = require('node:assert');
const { encode, decode } = require('../src/wjm1');
const T0 = Date.UTC(2026, 9, 5, 0, 0) / 1000;
function sample() {
  const rows = []; let p = 3900000;
  for (let i = 0; i < 500; i++) {
    const o = p, c = o + ((i * 37) % 21) - 10, h = Math.max(o, c) + (i % 5), l = Math.min(o, c) - (i % 7);
    rows.push({ t: T0 + (i < 250 ? i : i + 60) * 60, o, h, l, c, v: Math.fround(((i * 13) % 200) / 1e5) }); p = c;
  }
  return rows;
}
test('v1 round trip is exact, including time gaps and volume', () => {
  const rows = sample(), d = decode(encode(rows, 3, 1));
  assert.strictEqual(d.version, 1); assert.strictEqual(d.digits, 3); assert.deepStrictEqual(d.rows, rows); assert.deepStrictEqual(d.runs, [[0, 500]]);
});
test('v2 candidate round trip is exact for volumes that are multiples of 1e-5', () => {
  const rows = sample(), d = decode(encode(rows, 3, 2));
  assert.strictEqual(d.version, 2); assert.deepStrictEqual(d.rows, rows);
});
test('source runs survive', () => {
  const rows = sample(), d = decode(encode(rows, 3, 1, [[0, 300], [1, 200]]));
  assert.deepStrictEqual(d.runs, [[0, 300], [1, 200]]);
});
test('empty month and unknown version', () => {
  assert.deepStrictEqual(decode(encode([], 3, 1)).rows, []);
  const gz = require('zlib').gzipSync(Buffer.from('WJM1\x09\x03' + '\0'.repeat(8) + '\0', 'latin1'));
  assert.throws(() => decode(gz), /unsupported version/);
});
