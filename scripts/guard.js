'use strict';
// CI guard: this repository must contain code only. Fails on data-like files, large files, or secret-looking strings.
const fs = require('fs'), path = require('path');
const BAD_EXT = /\.(bi5|m1|gz|zip|csv|parquet|bin|db|sqlite)$/i, SECRET = /(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sb_secret_|service_role|lse_live_|AIza[0-9A-Za-z_-]{20}|AQ\.Ab8|ghp_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY|\.workers\.dev|\.supabase\.co)/;
let bad = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    if (n === '.git' || n === 'node_modules' || n === 'work' || n === 'out') continue;
    const p = path.join(d, n), st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (BAD_EXT.test(n)) bad.push('data-like file: ' + p); if (st.size > 200000) bad.push('large file: ' + p);
    if (n !== 'guard.js' && SECRET.test(fs.readFileSync(p, 'utf8'))) bad.push('secret-like string in: ' + p);
  }
})(path.join(__dirname, '..'));
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('guard ok: code only, no data, no secret-like strings');
