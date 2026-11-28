'use strict';
process.env.HUB_ALLOW_LOOPBACK = '1';
const test = require('node:test'), assert = require('node:assert');
const { mock } = require('./mock-supabase'), { Store } = require('../src/hub/store'), { Publisher, finalize, gc } = require('../src/hub/publish');
const { HubReader } = require('../src/hub/verify'), { newKeyPair, keyId, sha256 } = require('../src/hub/sign'), { GOOD } = require('./helpers'), { readV1 } = require('./ref-v1-reader'), { serialize } = require('../src/hub/manifest');
const KEYS = newKeyPair(), trusted = { [keyId(KEYS.publicPem)]: KEYS.publicPem };
const dates = []; for (let d = 1; d <= 31; d++) { const s = `2026-10-${String(d).padStart(2, '0')}`; if (new Date(s + 'T00:00:00Z').getUTCDay() !== 6) dates.push(s); }
async function env() {
  const S = await mock().start(); S.addUser('w@x', 'pw-writer', 'hub_writer'); S.addUser('r@x', 'pw-reader', 'hub_reader');
  test.after(() => S.stop());
  const mk = (e, p) => new Store({ url: S.url, expectedHost: S.host, anonKey: S.anon, email: e, password: p }), W = mk('w@x', 'pw-writer'), R = mk('r@x', 'pw-reader');
  const calls = { n: 0 }, fetchDay = async () => { calls.n++; return { kind: 'ok', buf: GOOD }; };
  const pub = () => new Publisher({ store: W, sym: 'XAUUSD', digits: 3 });
  const reader = o => new HubReader(Object.assign({ read: (p, max) => R.get('hub', p, max), trusted }, o));
  const run = async (p = pub(), f = fetchDay) => { const r = await p.syncDays(dates, f); const b = await p.buildMonth('2026-10'); const out = { sync: r, built: b }; if (b.complete) out.pubd = await p.publishMonth('2026-10', b); return out; };
  return { S, W, R, calls, pub, reader, run, fetchDay };
}
test('end to end: download → raw store → month → candidate → signed manifest → reader verifies and decodes (and matches the independent v1 reader)', async () => {
  const E = await env(); const r = await E.run();
  assert.strictEqual(r.sync.fetched, dates.length); assert.deepStrictEqual(r.sync.failed, []); assert.ok(r.built.complete && r.pubd.changed && r.pubd.v === 1);
  assert.strictEqual(r.built.rows, dates.length * 60);
  assert.rejects(E.reader().manifest(), /missing/);                                // nothing is trusted before signing
  assert.deepStrictEqual(await finalize({ store: E.W, privatePem: KEYS.privatePem }), { seq: 1 });
  const rd = E.reader(), m = await rd.manifest(), d = await rd.month('XAUUSD', '2026-10');
  assert.strictEqual(m.symbols.XAUUSD.months['2026-10'].rows, dates.length * 60); assert.strictEqual(d.rows.length, dates.length * 60);
  const file = await E.R.get('hub', 'fx/XAUUSD/2026-10.v1.m1.gz'); assert.deepStrictEqual(readV1(file).rows, d.rows, 'independent v1 reader agrees');
});
test('resume: second run downloads nothing, uploads no new version, and state survives a fresh process (state is remote)', async () => {
  const E = await env(); await E.run(); E.calls.n = 0; const before = [...E.S.buckets.hub.keys()].length;
  const r = await E.run(E.pub()); assert.strictEqual(E.calls.n, 0); assert.strictEqual(r.sync.skipped, dates.length); assert.strictEqual(r.pubd.changed, false); assert.strictEqual([...E.S.buckets.hub.keys()].length, before);
});
test('failure mid-run: failed days are recorded, nothing incomplete is published, next run fetches exactly those days', async () => {
  const E = await env(); let k = 0; const flaky = async d => { E.calls.n++; return ++k % 10 === 0 ? { kind: 'fail' } : { kind: 'ok', buf: GOOD }; };
  const r1 = await E.run(E.pub(), flaky); assert.ok(r1.sync.failed.length === 2); assert.strictEqual(r1.built.complete, false); assert.deepStrictEqual([...E.S.buckets.hub.keys()], [], 'no month file was published for an incomplete month');
  assert.deepStrictEqual(r1.built.missing.sort(), r1.sync.failed.sort());
  E.calls.n = 0; const r2 = await E.run(E.pub()); assert.strictEqual(E.calls.n, r1.sync.failed.length, 'only the failed days are requested'); assert.ok(r2.built.complete && r2.pubd.changed);
});
test('failure: garbage download and dropped connection while uploading are never recorded as complete', async () => {
  const E = await env(); const garbage = async () => ({ kind: 'ok', buf: Buffer.from('<html>error page long enough to look like data</html>') });
  const r1 = await E.run(E.pub(), garbage); assert.strictEqual(r1.sync.failed.length, dates.length); assert.strictEqual(r1.built.complete, false);
  E.S.failPuts = 2; const r2 = await E.pub().syncDays(dates.slice(0, 5), E.fetchDay); assert.strictEqual(r2.failed.length, 2);
  const r3 = await E.pub().syncDays(dates.slice(0, 5), E.fetchDay); assert.deepStrictEqual(r3.failed, []);
});
test('tamper: raw day object deleted / replaced (same size or not) / month file deleted — all detected and repaired on the next run', async () => {
  const E = await env(); await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  const names = [...E.S.buckets['hub-raw'].keys()].filter(n => n.startsWith('raw/')); assert.strictEqual(names.length, dates.length);
  E.S.buckets['hub-raw'].delete(names[0]);                                                               // deleted
  E.S.buckets['hub-raw'].set(names[1], Buffer.concat([Buffer.from([0]), E.S.buckets['hub-raw'].get(names[1]).subarray(1)]));   // same size, different bytes
  E.S.buckets['hub-raw'].set(names[2], Buffer.from('short'));                                            // different size
  E.calls.n = 0; const p = E.pub(); const s = await p.syncDays(dates, E.fetchDay); assert.strictEqual(s.fetched, 1, 'only the missing object is noticed by the cheap listing check');
  const b = await p.buildMonth('2026-10'); assert.strictEqual(b.complete, false, 'content check at build time catches same-size and size-changing corruption'); assert.strictEqual(b.missing.length, 2);
  const again = await E.run(E.pub()); assert.ok(again.built.complete, 'second pass refetches and repairs through delete+write'); assert.strictEqual(again.pubd.changed, false, 'the repaired month is identical to the published one');
  for (const n of names) assert.strictEqual(sha256(E.S.buckets['hub-raw'].get(n)), sha256(GOOD));
});
test('tamper after publication: month file / manifest / rollback are rejected by the reader; the signed state is untouched', async () => {
  const E = await env(); await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  const rd0 = E.reader(); await rd0.manifest(); const oldM = E.S.buckets.hub.get('manifest.json'), oldS = E.S.buckets.hub.get('manifest.sig');
  const mf = 'fx/XAUUSD/2026-10.v1.m1.gz', good = E.S.buckets.hub.get(mf); const bad = Buffer.from(good); bad[bad.length - 9] ^= 0x55; E.S.buckets.hub.set(mf, bad);
  await assert.rejects(E.reader().month('XAUUSD', '2026-10'), /hash mismatch/); E.S.buckets.hub.set(mf, good); assert.ok(await E.reader().month('XAUUSD', '2026-10'));
  // a new signed version, then an attacker replays the old signed pair
  const p = E.pub(); const c = await p.candidate(); c.symbols.XAUUSD.months['2026-10'].v = 2; c.symbols.XAUUSD.months['2026-10'].bytes = good.length; c.symbols.XAUUSD.months['2026-10'].sha256 = sha256(good);
  await E.W.put('hub', 'fx/XAUUSD/2026-10.v2.m1.gz', good); await E.W.put('hub-raw', 'candidate/manifest.json', serialize(c), { upsert: true }); assert.deepStrictEqual(await finalize({ store: E.W, privatePem: KEYS.privatePem }), { seq: 2 });
  const live = E.reader(); assert.strictEqual((await live.manifest()).seq, 2);
  E.S.buckets.hub.set('manifest.json', oldM); E.S.buckets.hub.set('manifest.sig', oldS); await assert.rejects(live.manifest(), /rollback/);
  const fresh = E.reader(); assert.strictEqual((await fresh.manifest()).seq, 1, 'a brand-new client cannot detect a replay of an older valid pair (documented limit); clients persist lastSeq');
});
test('writer credentials alone cannot publish trusted data: forged manifest signed with another key is rejected', async () => {
  const E = await env(); await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  const evil = newKeyPair(); await finalize({ store: E.W, privatePem: evil.privatePem });                  // attacker (writer) publishes a manifest signed with their own key
  await assert.rejects(E.reader().manifest(), /unknown signing key/);
});
test('finalize refuses to sign when there is no candidate or the published manifest is unreadable', async () => {
  const E = await env(); await assert.rejects(finalize({ store: E.W, privatePem: KEYS.privatePem }), /no candidate/);
  await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem }); E.S.buckets.hub.set('manifest.json', Buffer.from('garbage')); await assert.rejects(finalize({ store: E.W, privatePem: KEYS.privatePem }), /unreadable/);
});
test('gc keeps the two newest versions and never touches the manifest or other symbols', async () => {
  const E = await env(); await E.run(); const mb0 = E.S.buckets.hub; for (const v of [2, 3, 4]) mb0.set(`fx/XAUUSD/2026-10.v${v}.m1.gz`, Buffer.from('x'));
  mb0.set('fx/EURUSD/2026-10.v1.m1.gz', Buffer.from('y')); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  const man = E.S.buckets.hub.get('manifest.json'); const c = JSON.parse(man); c.symbols.XAUUSD.months['2026-10'].v = 4; const r = await gc({ store: E.W, manifestBytes: Buffer.from(JSON.stringify(c)) });
  assert.strictEqual(r.deleted, 2); assert.deepStrictEqual([...mb0.keys()].filter(k => k.startsWith('fx/XAUUSD')).sort(), ['fx/XAUUSD/2026-10.v3.m1.gz', 'fx/XAUUSD/2026-10.v4.m1.gz']); assert.ok(mb0.has('manifest.json') && mb0.has('fx/EURUSD/2026-10.v1.m1.gz'));
});
test('no secret ever reaches stored objects or the mock log', async () => {
  const E = await env(); await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  const all = JSON.stringify(E.S.log); assert.ok(!all.includes('pw-writer') && !all.includes('pw-reader') && !all.includes('PRIVATE KEY'));
  for (const B of Object.values(E.S.buckets)) for (const v of B.values()) assert.ok(!v.toString('latin1').includes('PRIVATE KEY') && !v.toString('latin1').includes('pw-writer'));
  assert.ok(E.S.log.every(l => l.role === 'hub_writer' || l.role === 'hub_reader'), 'only the two dedicated identities were used');
});
test('lost candidate entry (month file uploaded earlier, manifest entry missing): the identical file is adopted, no new version is created', async () => {
  const E = await env(); await E.run(); E.S.buckets['hub-raw'].delete('candidate/manifest.json');       // simulate the lost-update situation seen on the real project
  const r = await E.run(E.pub()); assert.ok(r.pubd.changed && r.pubd.v === 1, 'adopted as v1'); assert.deepStrictEqual([...E.S.buckets.hub.keys()].filter(k => k.startsWith('fx/')), ['fx/XAUUSD/2026-10.v1.m1.gz']);
  assert.deepStrictEqual(await finalize({ store: E.W, privatePem: KEYS.privatePem }), { seq: 1 }); assert.ok(await E.reader().month('XAUUSD', '2026-10'));
});
test('name taken by DIFFERENT bytes: the next version is used and the old file is left untouched', async () => {
  const E = await env(); await E.run(); E.S.buckets['hub-raw'].delete('candidate/manifest.json'); const old = Buffer.from('not the real month'); E.S.buckets.hub.set('fx/XAUUSD/2026-10.v1.m1.gz', old);
  const r = await E.run(E.pub()); assert.ok(r.pubd.changed && r.pubd.v === 2); assert.strictEqual(E.S.buckets.hub.get('fx/XAUUSD/2026-10.v1.m1.gz').toString(), 'not the real month');
});
test('candidate is read once per run: a stale re-read cannot drop months published earlier in the same run', async () => {
  const E = await env(); const p = E.pub(); await p.syncDays(dates, E.fetchDay); const b = await p.buildMonth('2026-10'); await p.publishMonth('2026-10', b);
  const real = E.W.get.bind(E.W); let reads = 0; E.W.get = async (bk, path, max) => { if (path === 'candidate/manifest.json') { reads++; return null; } return real(bk, path, max); };   // storage keeps answering "missing/stale"
  const b2 = Object.assign({}, b, { bytes: Buffer.concat([b.bytes, Buffer.alloc(0)]) }); await p.publishMonth('2026-10', b2); assert.strictEqual(reads, 0, 'no re-read after the first load');
  E.W.get = real; const c = await p.candidate(); assert.ok(c.symbols.XAUUSD.months['2026-10']);
});
test('stale copies after an overwrite (real Supabase behaviour) do not break publishing: finalize twice, reader verifies the new pair', async () => {
  const E = await env(); E.S.stale = true; await E.run(); await finalize({ store: E.W, privatePem: KEYS.privatePem });
  assert.deepStrictEqual(await finalize({ store: E.W, privatePem: KEYS.privatePem }), { seq: 2 }, 'sequence advances even though a plain GET would return the old manifest');
  const m = await E.reader().manifest(); assert.strictEqual(m.seq, 2);
});
