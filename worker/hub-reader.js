// Candle Hub read-only gateway (Cloudflare Worker, ES module). Runs server-side only.
// The hub_reader password lives ONLY in this Worker's secrets; the app/browser never receives it. Callers present a revocable
// requester token (only SHA-256 hashes of tokens are stored here). It serves just the signed manifest and immutable month files.
// Bindings: HUB_URL, HUB_HOST, HUB_ANON_KEY (plain), HUB_READER_EMAIL, HUB_READER_PASSWORD, REQ_TOKEN_HASHES (secrets), ALLOW_ORIGIN (optional).
const ROUTES = [
  [/^\/(manifest\.json|manifest\.sig)$/, m => m[1], 60],
  [/^\/(fx\/[A-Z0-9]{3,12}\/\d{4}-(?:0[1-9]|1[0-2])\.v[1-9]\d{0,5}\.m1\.gz)$/, m => m[1], 31536000],  // immutable: versioned names are never rewritten
];
const MAX = 8 << 20;
let session = null;                                                                // { token, exp } kept per isolate

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function base(env) {
  const u = new URL(env.HUB_URL);
  if (u.host !== env.HUB_HOST) throw new Error('hub host mismatch');
  if (u.protocol !== 'https:' && !(env.HUB_ALLOW_LOOPBACK === '1' && u.hostname === '127.0.0.1')) throw new Error('hub url must be https');
  return u.origin;
}
async function login(env) {
  const r = await fetch(`${base(env)}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env.HUB_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email: env.HUB_READER_EMAIL, password: env.HUB_READER_PASSWORD }) });
  if (!r.ok) throw new Error('upstream login failed');
  const j = await r.json(); if (!j.access_token) throw new Error('upstream login: no token');
  session = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
}
async function upstream(env, path, retry = true) {
  if (!session || session.exp < Date.now()) await login(env);
  const r = await fetch(`${base(env)}/storage/v1/object/authenticated/hub/${path.split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}`, { headers: { apikey: env.HUB_ANON_KEY, authorization: 'Bearer ' + session.token } });
  if (r.status === 401 && retry) { session = null; await r.arrayBuffer(); return upstream(env, path, false); }
  return r;
}
function out(env, status, body, extra) {
  return new Response(body, { status, headers: Object.assign({ 'access-control-allow-origin': env.ALLOW_ORIGIN || '*', 'access-control-allow-headers': 'authorization', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }, extra) });
}
export default {
  async fetch(req, env, ctx) {
    try {
      if (req.method === 'OPTIONS') return out(env, 204, null, { 'access-control-allow-methods': 'GET, HEAD', 'access-control-max-age': '86400' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return out(env, 405, 'method not allowed', { allow: 'GET, HEAD, OPTIONS' });
      const url = new URL(req.url); let route = null;
      for (const [re, name, ttl] of ROUTES) { const m = re.exec(url.pathname); if (m) { route = { path: name(m), ttl }; break; } }
      if (!route) return out(env, 404, 'not found');
      const tok = (/^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('authorization') || '') || [])[1];
      const ok = tok && (await (async () => { const h = await sha256hex(tok); return String(env.REQ_TOKEN_HASHES || '').split(',').map(s => s.trim()).filter(Boolean).some(x => same(x, h)); })());
      if (!ok) return out(env, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      const cache = typeof caches !== 'undefined' ? caches.default : null, key = new Request(url.origin + url.pathname);   // auth is checked before the cache is consulted
      if (cache) { const hit = await cache.match(key); if (hit) return out(env, 200, req.method === 'HEAD' ? null : hit.body, { 'content-type': hit.headers.get('content-type'), 'cache-control': hit.headers.get('cache-control') }); }
      const r = await upstream(env, route.path);
      if (r.status === 404 || r.status === 400) { await r.arrayBuffer(); return out(env, 404, 'not found'); }   // Storage answers a missing object as 400 + statusCode 404
      if (!r.ok) { await r.arrayBuffer(); return out(env, 502, 'upstream error'); }
      const b = await r.arrayBuffer(); if (b.byteLength > MAX) return out(env, 502, 'object too large');
      const ct = route.path.endsWith('.json') ? 'application/json' : 'application/octet-stream', cc = `public, max-age=${route.ttl}${route.ttl > 3600 ? ', immutable' : ''}`;
      if (cache) ctx.waitUntil(cache.put(key, new Response(b, { headers: { 'content-type': ct, 'cache-control': cc } })));
      return out(env, 200, req.method === 'HEAD' ? null : b, { 'content-type': ct, 'cache-control': cc });
    } catch (e) { return out(env, 502, 'upstream unavailable'); }   // never echo error text: it could contain upstream details
  },
};
