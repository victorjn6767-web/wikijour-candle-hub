'use strict';
const test = require('node:test'), assert = require('node:assert'), zlib = require('zlib');
const { readV1 } = require('./ref-v1-reader'), { encode } = require('../src/wjm1');
const E0 = 946684800;
test('independent reference reader agrees with the encoder and with the frozen vector', () => {
  const rows = []; let p = 3900000; for (let i = 0; i < 400; i++) { const o = p, c = o + ((i * 11) % 15) - 7; rows.push({ t: E0 + 8333333 * 60 + (i + (i > 200 ? 90 : 0)) * 60, o, h: Math.max(o, c) + 3, l: Math.min(o, c) - 2, c, v: Math.fround(((i * 17) % 300) / 1e5) }); p = c; }
  const r = readV1(encode(rows, 3, 1)); assert.deepStrictEqual(r.rows, rows); assert.strictEqual(r.digits, 3);
  const golden = '574a4d31010303000000a0050000000104d00f000005000202010104010482d1eec70300efa48cd003010003';
  const g = readV1(zlib.gzipSync(Buffer.from(golden, 'hex'))); assert.strictEqual(g.count, 3); assert.strictEqual(g.rows[2].c, 1003);
});
