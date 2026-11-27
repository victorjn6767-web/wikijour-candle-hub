'use strict';
// Compatibility guard: format version 1 must never change. Any reader written for v1 must keep reading these bytes.
const test = require('node:test'), assert = require('node:assert'), zlib = require('zlib');
const { encode, decode } = require('../src/wjm1');
const E0 = 946684800;
const rows = [
  { t: E0 + 86400, o: 1000, h: 1005, l: 998, c: 1002, v: Math.fround(0.00012) },
  { t: E0 + 86400 + 60, o: 1002, h: 1002, l: 1001, c: 1001, v: 0 },
  { t: E0 + 86400 + 300, o: 1001, h: 1003, l: 1000, c: 1003, v: Math.fround(0.0005) },
];
const GOLDEN_HEX = '574a4d31010303000000a0050000000104d00f000005000202010104010482d1eec70300efa48cd003010003';
test('v1 encoder output (before gzip) is byte-identical to the frozen vector', () => {
  assert.strictEqual(zlib.gunzipSync(encode(rows, 3, 1)).toString('hex'), GOLDEN_HEX);
});
test('v1 decoder reads the frozen vector', () => {
  const d = decode(zlib.gzipSync(Buffer.from(GOLDEN_HEX, 'hex')));
  assert.strictEqual(d.version, 1); assert.deepStrictEqual(d.rows, rows);
});
