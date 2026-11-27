'use strict';
// Simulated Supabase (Auth password login + private-bucket Storage REST). Authorization uses the SAME declaration as the SQL policies
// (src/hub/policies.js). Not the real service: it is a model for tests, nothing here talks to the network except loopback.
const http = require('http'), crypto = require('crypto');
const { allowed } = require('../src/hub/policies');
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function mock() {
  const S = { secret: crypto.randomBytes(16).toString('hex'), anon: null, users: {}, buckets: { hub: new Map(), 'hub-raw': new Map() }, log: [], failPuts: 0, ttl: 3600, logins: 0 };
  const jwt = c => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(c); return `${h}.${p}.${crypto.createHmac('sha256', S.secret).update(h + '.' + p).digest('base64url')}`; };
  const unjwt = t => { const [h, p, s] = String(t).split('.'); if (!s || crypto.createHmac('sha256', S.secret).update(h + '.' + p).digest('base64url') !== s) return null; const c = JSON.parse(Buffer.from(p, 'base64url')); return c.exp && c.exp < Date.now() / 1e3 ? 'expired' : c; };
  S.anon = jwt({ role: 'anon' });
  S.addUser = (email, password, hubRole, extra) => { S.users[email] = { password, claims: Object.assign({ role: 'authenticated', sub: crypto.randomUUID(), app_metadata: hubRole ? { hub_role: hubRole } : {} }, extra || {}) }; };
  const send = (res, code, body, h) => { res.writeHead(code, Object.assign({ 'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }, h)); res.end(typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body); };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks), u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
      if (p === '/auth/v1/token') {
        if (req.headers.apikey !== S.anon) return send(res, 401, { error: 'bad apikey' });
        S.logins++; let d; try { d = JSON.parse(body); } catch (e) { return send(res, 400, {}); }
        const us = S.users[d.email]; if (!us || us.password !== d.password) return send(res, 400, { error: 'invalid_grant' });
        return send(res, 200, { access_token: jwt(Object.assign({ exp: Math.floor(Date.now() / 1e3) + S.ttl }, us.claims)) });
      }
      const m = /^\/storage\/v1\/object\/(authenticated|public|list)?\/?([^/]+)(?:\/(.*))?$/.exec(p); if (!m) return send(res, 404, {});
      let [, kind, a, b] = m; let bucket, name; if (kind === 'list') { bucket = a; name = null; } else if (kind) { bucket = a; name = b; } else { bucket = a; name = b; }
      if (kind === 'public') return send(res, 400, { statusCode: '404', error: 'Bucket not found' });          // private buckets: no public URLs
      const tok = (req.headers.authorization || '').replace(/^Bearer /, ''); if (req.headers.apikey !== S.anon) return send(res, 401, { error: 'bad apikey' });
      const c = tok === S.anon ? { role: 'anon' } : unjwt(tok); if (!c) return send(res, 401, { error: 'bad token' }); if (c === 'expired') return send(res, 401, { error: 'expired' });
      const role = c.role === 'authenticated' ? (c.app_metadata || {}).hub_role || '' : '__anon';       // user_metadata is deliberately ignored
      const B = S.buckets[bucket]; const deny = (op, why) => { S.log.push({ op, bucket, name, role, result: 'deny' }); return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: why || 'new row violates row-level security policy' }); };
      const ok = (op) => S.log.push({ op, bucket, name, role, result: 'allow' });
      if (!B) return deny('?', 'bucket not found');
      if (kind === 'list') {
        const prefix = JSON.parse(body).prefix || ''; const out = [];
        for (const [n, v] of B) { if (n.startsWith(prefix + '/') && !n.slice(prefix.length + 1).includes('/') && allowed('SELECT', bucket, n, role)) out.push({ name: n.slice(prefix.length + 1), metadata: { size: v.length } }); else if (n.startsWith(prefix + '/') && n.slice(prefix.length + 1).includes('/')) { /* folders omitted */ } }
        // folder listing: Supabase returns sub-folders as entries without metadata; emulate for completeness
        ok('LIST'); return send(res, 200, out);
      }
      if (req.method === 'GET') { if (!allowed('SELECT', bucket, name, role)) { S.log.push({ op: 'SELECT', bucket, name, role, result: 'deny' }); return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' }); } ok('SELECT'); const v = B.get(name); if (!v) return send(res, 404, { statusCode: '404', error: 'not_found' }); return send(res, 200, v); }
      if (req.method === 'POST') {
        const up = req.headers['x-upsert'] === 'true', exists = B.has(name);
        if (!allowed('INSERT', bucket, name, role)) return deny('INSERT');
        if (exists && !up) { ok('INSERT'); return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }); }
        if (exists && up && !(allowed('UPDATE', bucket, name, role) && allowed('SELECT', bucket, name, role))) return deny('UPDATE');
        if (S.failPuts > 0) { S.failPuts--; req.socket.destroy(); return; }
        B.set(name, Buffer.from(body)); ok(exists ? 'UPDATE' : 'INSERT'); return send(res, 200, { Key: bucket + '/' + name });
      }
      if (req.method === 'DELETE') { if (!allowed('DELETE', bucket, name, role)) return deny('DELETE'); B.delete(name); ok('DELETE'); return send(res, 200, {}); }
      send(res, 405, {});
    });
  });
  S.start = () => new Promise(r => srv.listen(0, '127.0.0.1', () => { S.port = srv.address().port; S.url = `http://127.0.0.1:${S.port}`; S.host = `127.0.0.1:${S.port}`; r(S); }));
  S.stop = () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); });
  return S;
}
module.exports = { mock };
