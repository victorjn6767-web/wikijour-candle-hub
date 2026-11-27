'use strict';
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto');
const { newKeyPair, keyId, sign, verify, sha256 } = require('../src/hub/sign'), M = require('../src/hub/manifest'), { HubReader } = require('../src/hub/verify');
const { encode } = require('../src/wjm1');
const A = newKeyPair(), B = newKeyPair(), trusted = { [keyId(A.publicPem)]: A.publicPem };
const entry = o => Object.assign({ v: 1, bytes: 10, sha256: 'a'.repeat(64), rows: 1, firstMin: 5, lastMin: 5 }, o);
const man = (o, sym) => Object.assign({ schema: 1, seq: 3, generated: '2026-11-27T12:00:00.000Z', symbols: { XAUUSD: Object.assign({ side: 'bid', digits: 3, months: { '2026-10': entry() } }, sym) } }, o);
test('canonical serialization is stable regardless of key order', () => {
  assert.deepStrictEqual(M.serialize({ b: 1, a: { d: 1, c: 2 } }), M.serialize({ a: { c: 2, d: 1 }, b: 1 }));
});
test('signature: valid, tampered manifest, wrong key, unknown keyId, bad algorithm, bad length', () => {
  const bytes = M.serialize(man()), sig = sign(bytes, A.privatePem);
  assert.strictEqual(verify(bytes, sig, trusted), true);
  assert.throws(() => verify(Buffer.concat([bytes, Buffer.from(' ')]), sig, trusted), /hash mismatch/);
  const forged = sign(bytes, B.privatePem); assert.throws(() => verify(bytes, forged, trusted), /unknown signing key/);
  const sigDoc = JSON.parse(sig); assert.throws(() => verify(bytes, Buffer.from(JSON.stringify(Object.assign({}, sigDoc, { keyId: keyId(B.publicPem) }))), { [keyId(B.publicPem)]: B.publicPem }), /bad signature/, 'claiming another key id with our signature fails');
  assert.throws(() => verify(bytes, Buffer.from(JSON.stringify(Object.assign({}, sigDoc, { alg: 'none' }))), trusted), /algorithm/);
  assert.throws(() => verify(bytes, Buffer.from(JSON.stringify(Object.assign({}, sigDoc, { sig: 'AAAA' }))), trusted), /signature length/);
  assert.throws(() => verify(bytes, Buffer.from('not json'), trusted), /not JSON/); assert.throws(() => verify(bytes, Buffer.alloc(5000), trusted), /too large/);
  assert.throws(() => verify(bytes, sig, { __proto__: null }), /unknown signing key/); assert.throws(() => verify(bytes, Buffer.from(JSON.stringify(Object.assign({}, sigDoc, { keyId: '__proto__' }))), {}), /unknown signing key/);
});
test('a flipped byte of a signed manifest is rejected even if the SHA field is recomputed by the attacker', () => {
  const bytes = M.serialize(man()), sig = JSON.parse(sign(bytes, A.privatePem)), evil = Buffer.from(bytes.toString().replace('"seq":3', '"seq":4'));
  sig.manifestSha256 = sha256(evil); assert.throws(() => verify(evil, Buffer.from(JSON.stringify(sig)), trusted), /bad signature/);
});
test('manifest schema: strict validation and limits', () => {
  const ok = M.serialize(man()); assert.strictEqual(M.parse(ok).seq, 3);
  const bad = [man({ schema: 2 }), man({ seq: 0 }), man({ seq: 1.5 }), man({ generated: 'nope' }), man({ symbols: [] }), man({ symbols: { xauusd: { side: 'bid', digits: 3, months: {} } } }),
    man({}, { side: 'ask' }), man({}, { digits: 99 }), man({}, { months: { '2026-13': entry() } }), man({}, { months: { '2026-1': entry() } }), man({}, { months: { '../x': entry() } }),
    man({}, { months: { '2026-10': entry({ v: 0 }) } }), man({}, { months: { '2026-10': entry({ bytes: M.LIM.file + 1 }) } }), man({}, { months: { '2026-10': entry({ sha256: 'zz' }) } }),
    man({}, { months: { '2026-10': entry({ rows: M.LIM.rowsPerMonth + 1 }) } }), man({}, { months: { '2026-10': entry({ lastMin: 1 }) } })];
  bad.forEach((m, i) => assert.throws(() => M.parse(Buffer.from(JSON.stringify(m))), /bad|too/, 'case ' + i));
  assert.throws(() => M.parse(Buffer.alloc(M.LIM.manifest + 1, 32)), /too large/); assert.throws(() => M.parse(Buffer.from('{')), /not JSON/);
});
test('paths are derived from symbol/month/version only (a manifest cannot point elsewhere)', () => {
  assert.strictEqual(M.monthPath('XAUUSD', '2026-10', 3), 'fx/XAUUSD/2026-10.v3.m1.gz');
  const withPath = M.parse(Buffer.from(JSON.stringify(man({}, { months: { '2026-10': Object.assign(entry(), { path: '../../x' }) } }))));
  assert.strictEqual(M.monthPath('XAUUSD', '2026-10', withPath.symbols.XAUUSD.months['2026-10'].v), 'fx/XAUUSD/2026-10.v1.m1.gz', 'an extra path field is never consulted');
});
// ---- reader against an in-memory file set ----
function month(rowsN = 120, o = {}) {
  const t0 = Date.UTC(2026, 9, 5) / 1e3, rows = []; let p = 3900000;
  for (let i = 0; i < rowsN; i++) { const op = p, c = op + ((i * 7) % 9) - 4; rows.push({ t: t0 + i * 60, o: op, c, l: Math.min(op, c) - 1, h: Math.max(op, c) + 2, v: Math.fround((i % 50) / 1e5) }); p = c; }
  return { rows, gz: encode(Object.assign(rows, o.rows), 3, 1) };
}
function fileset(seq = 5, gz = month().gz, rowsN = 120, priv = A.privatePem) {
  const first = (Date.UTC(2026, 9, 5) / 1e3 - 946684800) / 60, m = man({ seq }, { months: { '2026-10': entry({ v: 2, bytes: gz.length, sha256: sha256(gz), rows: rowsN, firstMin: first, lastMin: first + rowsN - 1 }) } }), mb = M.serialize(m);
  return new Map([['manifest.json', mb], ['manifest.sig', sign(mb, priv)], ['fx/XAUUSD/2026-10.v2.m1.gz', gz]]);
}
const rdr = (files, o) => new HubReader(Object.assign({ read: async p => files.get(p) || null, trusted }, o));
test('reader: accepts a good signed manifest and verifies and decodes a month', async () => {
  const f = fileset(), r = rdr(f), m = await r.manifest(); assert.strictEqual(m.seq, 5); const d = await r.month('XAUUSD', '2026-10'); assert.strictEqual(d.rows.length, 120);
});
test('reader: rejects forged signature, tampered manifest, missing pieces', async () => {
  await assert.rejects(rdr(fileset(5, undefined, 120, B.privatePem)).manifest(), /unknown signing key/);
  const f = fileset(); f.set('manifest.json', Buffer.from(f.get('manifest.json').toString().replace('"seq":5', '"seq":6'))); await assert.rejects(rdr(f).manifest(), /hash mismatch/);
  const g = fileset(); g.delete('manifest.sig'); await assert.rejects(rdr(g).manifest(), /missing/);
});
test('reader: rollback to an older signed manifest is rejected; same or newer is fine', async () => {
  const r = rdr(fileset(7)); await r.manifest(); const old = fileset(6); r.read = async p => old.get(p) || null; r.m = null;
  await assert.rejects(r.manifest(), /rollback/); const same = fileset(7); r.read = async p => same.get(p) || null; assert.strictEqual((await r.manifest()).seq, 7);
});
test('reader: stale manifest rejected when a maximum age is set', async () => {
  const r = rdr(fileset(), { maxAgeSec: 3600, now: () => Date.parse('2026-11-27T12:00:00Z') + 7200e3 }); await assert.rejects(r.manifest(), /too old/);
  const ok = rdr(fileset(), { maxAgeSec: 3600, now: () => Date.parse('2026-11-27T12:00:00Z') + 60e3 }); assert.ok(await ok.manifest());
});
test('reader: month file tampering — flipped byte, wrong size, truncated, swapped with another valid file, decompression bomb', async () => {
  const gz = month().gz;
  const flip = fileset(); const b = Buffer.from(gz); b[b.length >> 1] ^= 1; flip.set('fx/XAUUSD/2026-10.v2.m1.gz', b); await assert.rejects(rdr(flip).month('XAUUSD', '2026-10'), /mismatch/);
  const tr = fileset(); tr.set('fx/XAUUSD/2026-10.v2.m1.gz', gz.subarray(0, gz.length - 4)); await assert.rejects(rdr(tr).month('XAUUSD', '2026-10'), /mismatch/);
  const other = fileset(); other.set('fx/XAUUSD/2026-10.v2.m1.gz', month(60).gz); await assert.rejects(rdr(other).month('XAUUSD', '2026-10'), /mismatch/);
  const bomb = require('zlib').gzipSync(Buffer.alloc(M.LIM.decoded + 1024), { level: 9 }), bf = fileset(5, bomb, 120); await assert.rejects(rdr(bf).month('XAUUSD', '2026-10'), /too large|invalid/);
  const miss = fileset(); miss.delete('fx/XAUUSD/2026-10.v2.m1.gz'); await assert.rejects(rdr(miss).month('XAUUSD', '2026-10'), /missing/);
});
test('reader: validly signed but internally wrong data is still rejected (rows, order, OHLC, month bounds, first/last minute)', async () => {
  const mk = (mut, n = 120) => { const { rows } = month(n); mut(rows); return encode(rows, 3, 1); };
  const cases = { order: g => { g[5].t = g[4].t; }, ohlc: g => { g[3].h = g[3].l - 1; }, zero: g => { g[3].l = 0; g[3].o = 0; }, neg: g => { g[2].v = -1; }, outside: g => { g.forEach(k => { k.t += 40 * 864e2 * 1; }); }, offgrid: g => { g[1].t += 7; } };
  for (const [name, mut] of Object.entries(cases)) { const gz = mk(mut); await assert.rejects(rdr(fileset(5, gz)).month('XAUUSD', '2026-10'), /invalid|mismatch/, name); }
  await assert.rejects(rdr(fileset(5, month(100).gz, 120)).month('XAUUSD', '2026-10'), /mismatch|count/, 'row count differs from manifest');
});
