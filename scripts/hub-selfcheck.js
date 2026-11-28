'use strict';
// Checks the REAL access model of the Hub project from outside: what each identity can and cannot do.
// Run it on YOUR machine (reader credentials never go to GitHub). Credentials come from the environment only; nothing is printed except check names.
//   always:  HUB_URL, HUB_HOST, HUB_ANON_KEY
//   reader checks: HUB_READER_EMAIL, HUB_READER_PASSWORD      writer checks: HUB_WRITER_EMAIL, HUB_WRITER_PASSWORD
//   HUB_SELFCHECK_WRITE=1 enables the writer checks that create and delete tiny objects under the throw-away symbol SELFTEST
//   (never touches manifest.json/manifest.sig or any real symbol; leaves only state/SELFTEST.json, which the writer cannot delete by design: remove it in the dashboard).
const { Store } = require('../src/hub/store'), { need } = require('../src/hub/env');
const url = need('HUB_URL'), host = need('HUB_HOST'), anon = need('HUB_ANON_KEY');
const mk = (p) => new Store({ url, expectedHost: host, anonKey: anon, email: process.env[p + '_EMAIL'], password: process.env[p + '_PASSWORD'] });
const MONTH = 'fx/SELFTEST/2026-01.v1.m1.gz', MONTH2 = 'fx/SELFTEST/2026-01.v2.m1.gz', RAW = 'raw/SELFTEST/2026/01/02.0123456789abcdef.bi5', STATE = 'state/SELFTEST.json';
let bad = 0; const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) bad++; };
const denied = async p => { try { await p; return false; } catch (e) { return e.status === 403 || e.status === 404 || e.status === 400; } };
const roleOf = async (s) => { await s.login(); const p = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url')); return (p.app_metadata || {}).hub_role || '(none)'; };
(async () => {
  // anonymous (publishable key only)
  { const a = new Store({ url, expectedHost: host, anonKey: anon, email: 'x', password: 'x' }); Object.defineProperty(a, 'token', { value: anon, writable: true, enumerable: false });
    ok('anon: cannot write hub', await denied(a.put('hub', MONTH, Buffer.from('x')))); ok('anon: cannot read hub manifest (null or denied)', (await a.get('hub', 'manifest.json').catch(() => null)) === null);
    const r = await fetch(`${url}/storage/v1/object/public/hub/manifest.json`); ok('no public URL for bucket hub', r.status !== 200); const r2 = await fetch(`${url}/storage/v1/object/public/hub-raw/state/XAUUSD.json`); ok('no public URL for bucket hub-raw', r2.status !== 200); }
  if (process.env.HUB_READER_EMAIL) {
    const R = mk('HUB_READER'); ok('reader: token role is hub_reader', (await roleOf(R)) === 'hub_reader');
    ok('reader: cannot write month file', await denied(R.put('hub', MONTH, Buffer.from('x')))); ok('reader: cannot upsert manifest', await denied(R.put('hub', 'manifest.json', Buffer.from('x'), { upsert: true })));
    ok('reader: cannot delete in hub', await denied(R.del('hub', MONTH))); ok('reader: cannot write hub-raw', await denied(R.put('hub-raw', RAW, Buffer.from('x'))));
    ok('reader: hub-raw is invisible', (await R.get('hub-raw', STATE).catch(() => null)) === null); ok('reader: hub-raw listing is empty', (await R.list('hub-raw', 'state').catch(() => [])).length === 0);
  }
  if (process.env.HUB_WRITER_EMAIL) {
    const W = mk('HUB_WRITER'); ok('writer: token role is hub_writer', (await roleOf(W)) === 'hub_writer');
    ok('writer: cannot write outside the naming scheme', await denied(W.put('hub', 'evil.txt', Buffer.from('x'))));
    ok('writer: cannot use another bucket', await denied(W.put('public', MONTH, Buffer.from('x'))));
    if (process.env.HUB_SELFCHECK_WRITE === '1') {
      ok('writer: can write a month version', await W.put('hub', MONTH, Buffer.from('one')).then(() => true, () => false));
      ok('writer: month version is readable back', (await W.get('hub', MONTH).catch(() => null))?.toString() === 'one');
      ok('writer: month version is immutable (upsert denied)', await denied(W.put('hub', MONTH, Buffer.from('two'), { upsert: true })));
      ok('writer: duplicate insert is refused', await W.put('hub', MONTH, Buffer.from('dup')).then(() => false, e => e.status === 409 || e.status === 400));
      ok('writer: can delete an old month version (gc)', await W.del('hub', MONTH).then(() => true, () => false));
      await W.put('hub', MONTH2, Buffer.from('v2')).catch(() => {}); await W.del('hub', MONTH2).catch(() => {});
      ok('writer: can write a raw day object', await W.put('hub-raw', RAW, Buffer.from('r')).then(() => true, () => false));
      ok('writer: raw day object is immutable (upsert denied)', await denied(W.put('hub-raw', RAW, Buffer.from('r2'), { upsert: true })));
      ok('writer: can delete a raw day object (repair)', await W.del('hub-raw', RAW).then(() => true, () => false));
      ok('writer: can write and update state', await W.put('hub-raw', STATE, Buffer.from('1'), { upsert: true }).then(() => W.put('hub-raw', STATE, Buffer.from('2'), { upsert: true })).then(() => true, () => false));
      ok('writer: cannot delete state', await denied(W.del('hub-raw', STATE)));
      ok('writer: cannot delete the manifest', await denied(W.del('hub', 'manifest.json')));
    } else console.log('(writer mutation checks skipped: set HUB_SELFCHECK_WRITE=1)');
  }
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ERROR: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
