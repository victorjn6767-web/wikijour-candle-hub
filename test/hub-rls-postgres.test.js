'use strict';
// Runs the GENERATED policies (sql/hub-policies.sql) in a throw-away local PostgreSQL with the same RLS engine and the same auth.jwt()
// definition Supabase uses, and checks every (role, operation, bucket, name) outcome against the JS evaluator the simulated server uses.
// This proves the SQL means what the declaration says. It does NOT prove the real Supabase Storage API behaves identically.
const test = require('node:test'), assert = require('node:assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const P = require('../src/hub/policies');
const root = '/usr/lib/postgresql', vers = fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => b - a) : [];
const bin = vers.map(v => `${root}/${v}/bin`).find(d => fs.existsSync(d + '/initdb'));
// In CI (REQUIRE_PG=1) a missing PostgreSQL is a FAILURE, never a silent skip.
const skip = !bin && !process.env.REQUIRE_PG && 'PostgreSQL binaries not found: RLS test skipped (set REQUIRE_PG=1 to make this a failure)';
const asPg = process.getuid && process.getuid() === 0;
function sh(cmd, args, opt = {}) { const c = asPg ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args]; return cp.spawnSync(c[0], c[1], Object.assign({ encoding: 'utf8' }, opt)); }
const SETUP = `
create role anon nologin; create role authenticated nologin;
create schema auth; create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create schema storage; create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema auth, storage to anon, authenticated; grant execute on function auth.jwt() to anon, authenticated; grant select, insert, update, delete on storage.objects to anon, authenticated;
`;
const ROLES = { hub_writer: ['authenticated', { role: 'authenticated', app_metadata: { hub_role: 'hub_writer' } }], hub_reader: ['authenticated', { role: 'authenticated', app_metadata: { hub_role: 'hub_reader' } }],
  norole: ['authenticated', { role: 'authenticated', app_metadata: {} }], usermeta: ['authenticated', { role: 'authenticated', app_metadata: {}, user_metadata: { hub_role: 'hub_writer' } }], anon: ['anon', { role: 'anon' }] };
const NAMES = { hub: ['manifest.json', 'manifest.sig', 'fx/XAUUSD/2026-10.v1.m1.gz', 'fx/XAUUSD/2026-10.v12.m1.gz', 'fx/xauusd/2026-10.v1.m1.gz', 'evil.txt', 'manifest.json/x', 'raw/XAUUSD/2026/10/12.0123456789abcdef.bi5', 'state/XAUUSD.json'],
  'hub-raw': ['raw/XAUUSD/2026/10/12.0123456789abcdef.bi5', 'raw/XAUUSD/2026/10/12.bi5', 'state/XAUUSD.json', 'candidate/manifest.json', 'manifest.json', 'fx/XAUUSD/2026-10.v1.m1.gz', 'candidate/manifest.json.bak'], other: ['manifest.json'] };
test('PostgreSQL is available when required', () => { if (process.env.REQUIRE_PG) assert.ok(bin, 'REQUIRE_PG=1 but no PostgreSQL binaries found'); });
test('SQL policies behave exactly like the declaration for every role, operation, bucket and name (real PostgreSQL RLS)', { skip, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubpg-')); if (asPg) fs.chmodSync(dir, 0o777);
  const data = path.join(dir, 'd'), sock = dir; let started = false;
  try {
    let r = sh(bin + '/initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync']); assert.strictEqual(r.status, 0, r.stderr);
    r = sh(bin + '/pg_ctl', ['-D', data, '-o', `-c listen_addresses='' -c unix_socket_directories='${sock}' -p 5499`, '-w', '-l', path.join(dir, 'log'), 'start']); assert.strictEqual(r.status, 0, r.stdout + r.stderr); started = true;
    const psql = (sql) => sh(bin + '/psql', ['-h', sock, '-p', '5499', '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql });
    const out = []; let id = 0, sql = SETUP + '\n' + P.generateSql() + '\n';
    for (const [bucket, names] of Object.entries(NAMES)) for (const [rk, [pgrole, claims]] of Object.entries(ROLES)) for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) for (const name of names) {
      const cid = id++; out.push({ cid, bucket, rk, op, name, role: rk === 'hub_writer' || rk === 'hub_reader' ? rk : rk === 'anon' ? '__anon' : '' });
      const lit = s => "'" + s.replace(/'/g, "''") + "'", pre = op === 'INSERT' ? '' : `insert into storage.objects(bucket_id, name) values (${lit(bucket)}, ${lit(name)});`;
      const stmt = { SELECT: `perform 1 from storage.objects where bucket_id=${lit(bucket)} and name=${lit(name)}; get diagnostics n = row_count;`, INSERT: `insert into storage.objects(bucket_id, name) values (${lit(bucket)}, ${lit(name)}); n := 1;`,
        UPDATE: `update storage.objects set owner = gen_random_uuid() where bucket_id=${lit(bucket)} and name=${lit(name)}; get diagnostics n = row_count;`, DELETE: `delete from storage.objects where bucket_id=${lit(bucket)} and name=${lit(name)}; get diagnostics n = row_count;` }[op];
      sql += `begin; ${pre} do $$ declare n int := 0; begin set local role ${pgrole}; perform set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true); ${stmt} raise notice 'R % %', ${cid}, case when n > 0 then 'allow' else 'deny' end; exception when insufficient_privilege then raise notice 'R % deny', ${cid}; end $$; rollback;\n`;
    }
    r = psql(sql); assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 800));
    const got = {}; for (const m of (r.stderr + r.stdout).matchAll(/R (\d+) (allow|deny)/g)) got[m[1]] = m[2];
    assert.strictEqual(Object.keys(got).length, out.length, 'every case produced a result'); let allowN = 0;
    for (const c of out) { const want = P.allowed(c.op, c.bucket, c.name, c.role) ? 'allow' : 'deny'; if (want === 'allow') allowN++; assert.strictEqual(got[c.cid], want, `${c.rk} ${c.op} ${c.bucket}/${c.name}: db=${got[c.cid]} declaration=${want}`); }
    assert.ok(allowN > 15 && allowN < out.length / 3, 'sanity: a meaningful number of allows and many more denies (' + allowN + '/' + out.length + ')');
    console.log(`# real-PostgreSQL RLS cases checked: ${out.length}, allow: ${allowN}, deny: ${out.length - allowN}`);
  } finally { if (started) sh(bin + '/pg_ctl', ['-D', data, '-m', 'immediate', 'stop']); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});
