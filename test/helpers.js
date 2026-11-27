'use strict';
const cp = require('child_process'), http = require('http');
// A valid synthetic Dukascopy day file (LZMA-alone, 24-byte records), n minutes starting 00:00 UTC.
function makeDay(n = 60) {
  const b = Buffer.alloc(n * 24); let p = 3900000;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + ((i * 7) % 9) - 4, h = Math.max(o, c) + 2, l = Math.min(o, c) - 1;
    b.writeUInt32BE(i * 60, i * 24); b.writeUInt32BE(o, i * 24 + 4); b.writeUInt32BE(c, i * 24 + 8); b.writeUInt32BE(l, i * 24 + 12); b.writeUInt32BE(h, i * 24 + 16); b.writeFloatBE(((i * 13) % 200) / 1e5, i * 24 + 20); p = c;
  }
  return cp.spawnSync('xz', ['--format=lzma', '-zc'], { input: b }).stdout;
}
const GOOD = makeDay();
// Mock server: direct path /datafeed/<id>/<y>/<m0>/<dd>/..., proxy path /raw?...&y&m&d. Per-date modes, hit counters.
function server() {
  const S = { direct: {}, proxy: {}, hits: { direct: {}, proxy: {} } };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let date, via, mode;
    if (u.pathname.startsWith('/datafeed/')) { const p = u.pathname.split('/'); date = `${p[3]}-${String(+p[4] + 1).padStart(2, '0')}-${p[5]}`; via = 'direct'; }
    else { date = `${u.searchParams.get('y')}-${String(u.searchParams.get('m')).padStart(2, '0')}-${String(u.searchParams.get('d')).padStart(2, '0')}`; via = 'proxy'; }
    S.hits[via][date] = (S.hits[via][date] || 0) + 1; mode = (S[via][date] || S[via]['*'] || 'ok');
    const h = via === 'proxy' ? { 'x-upstream-status': '200' } : {};
    if (mode === 'ok') { res.writeHead(200, h); return res.end(GOOD); }
    if (mode === '503') { res.writeHead(503); return res.end('<html>503</html>'); }
    if (mode === '404') { res.writeHead(404); return res.end(); }
    if (mode === 'garbage') { res.writeHead(200, h); return res.end(Buffer.from('<html><body>error page that is long enough</body></html>')); }
    if (mode === 'tiny') { res.writeHead(200, h); return res.end(Buffer.alloc(3)); }
    if (mode === 'up404') { res.writeHead(200, { 'x-upstream-status': '404' }); return res.end(); }
    if (mode === 'drop') { req.socket.destroy(); return; }
    res.writeHead(500); res.end();
  });
  S.start = () => new Promise(r => srv.listen(0, '127.0.0.1', () => { S.port = srv.address().port; r(S); }));
  S.stop = () => new Promise(r => srv.close(r));
  return S;
}
function run(script, env) {
  return new Promise(res => {
    const c = cp.spawn(process.execPath, [script], { env: Object.assign({}, process.env, env), cwd: require('path').join(__dirname, '..') });
    let out = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => out += d); c.on('close', code => res({ code, out }));
  });
}
module.exports = { makeDay, GOOD, server, run };
