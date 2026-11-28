'use strict';
// Supabase Storage REST client (private buckets, password login as a dedicated Auth user). Never logs credentials or tokens.
const enc = p => p.split('/').map(encodeURIComponent).join('/');
class HubError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
function assertHubUrl(url, expectedHost) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.hostname === '127.0.0.1' && process.env.HUB_ALLOW_LOOPBACK === '1')) throw new HubError('hub url must be https', 0);
  if (!expectedHost || u.host !== expectedHost) throw new HubError('hub url host is not the configured Hub project host', 0);
  return u.origin;
}
class Store {
  // opts: { url, expectedHost, anonKey, email, password, fetch }
  constructor(o) {
    this.base = assertHubUrl(o.url, o.expectedHost); this.anon = o.anonKey; this.email = o.email; this.password = o.password; this.fetch = o.fetch || fetch; this.token = null;
    for (const k of ['anon', 'email', 'password']) Object.defineProperty(this, k, { enumerable: false, value: this[k], writable: true }); // keep secrets out of inspect/JSON
  }
  scrub(s) { let t = String(s); for (const v of [this.token, this.anon, this.password]) if (v && v.length >= 4) t = t.split(v).join('***'); return t; }
  async login() {
    const r = await this.fetch(`${this.base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: this.anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, password: this.password }) });
    if (!r.ok) throw new HubError('login failed (' + r.status + ')', r.status);
    const j = await r.json(); if (!j.access_token) throw new HubError('login: no token', 0);
    Object.defineProperty(this, 'token', { enumerable: false, value: j.access_token, writable: true });
  }
  async req(method, url, extra, retry = true) {
    if (!this.token) await this.login();
    const r = await this.fetch(url, Object.assign({ method }, extra, { headers: Object.assign({ apikey: this.anon, authorization: 'Bearer ' + this.token }, (extra || {}).headers) }));
    if (r.status === 401 && retry) { this.token = null; return this.req(method, url, extra, false); }
    return r;
  }
  // Supabase Storage reports many errors as HTTP 400 with the real code in the JSON body ({"statusCode":"404",...}); normalise to that code.
  async eff(r) { if (r.status !== 400) return r.status; try { const sc = +(JSON.parse(await r.clone().text()).statusCode); if (sc >= 400 && sc < 600) return sc; } catch (e) { /* not JSON */ } return r.status; }
  async fail(r, what) { const st = await this.eff(r); let t = ''; try { t = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ } throw new HubError(this.scrub(`${what} failed (${st}) ${t}`), st); }
  async put(bucket, path, bytes, { upsert = false } = {}) {
    const r = await this.req('POST', `${this.base}/storage/v1/object/${bucket}/${enc(path)}`, { headers: { 'content-type': 'application/octet-stream', 'x-upsert': upsert ? 'true' : 'false' }, body: bytes });
    if (!r.ok) await this.fail(r, `put ${bucket}/${path}`); await r.arrayBuffer(); return true;
  }
  async get(bucket, path, maxBytes = 1 << 20) {
    const r = await this.req('GET', `${this.base}/storage/v1/object/authenticated/${bucket}/${enc(path)}?t=${Date.now()}`);   // cache-buster: Supabase can serve a stale copy right after an overwrite (seen on the real project)
    if ((await this.eff(r)) === 404) { await r.arrayBuffer(); return null; }
    if (!r.ok) await this.fail(r, `get ${bucket}/${path}`);
    const len = +(r.headers.get('content-length') || 0); if (len > maxBytes) { await r.arrayBuffer().catch(() => {}); throw new HubError('object too large', 0); }
    const b = Buffer.from(await r.arrayBuffer()); if (b.length > maxBytes) throw new HubError('object too large', 0); return b;
  }
  async del(bucket, path) { const r = await this.req('DELETE', `${this.base}/storage/v1/object/${bucket}/${enc(path)}`); if (!r.ok) await this.fail(r, `delete ${bucket}/${path}`); await r.arrayBuffer(); return true; }
  async list(bucket, prefix) {
    const r = await this.req('POST', `${this.base}/storage/v1/object/list/${bucket}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000 }) });
    if (!r.ok) await this.fail(r, `list ${bucket}/${prefix}`); return r.json();
  }
}
module.exports = { Store, HubError, assertHubUrl };
