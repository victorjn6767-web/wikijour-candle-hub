'use strict';
// Shared configuration for the hub scripts. Credentials come ONLY from environment variables (GitHub Environment secrets / your shell).
const { Store } = require('./store');
function need(name) { const v = process.env[name]; if (!v) { console.error(`missing environment variable ${name}`); process.exit(2); } return v; }
function storeFor(prefix) {          // prefix: 'HUB_WRITER' | 'HUB_READER'
  const url = need('HUB_URL'), host = need('HUB_HOST');          // HUB_HOST = the one host this run may talk to (allowlist)
  return new Store({ url, expectedHost: host, anonKey: need('HUB_ANON_KEY'), email: need(prefix + '_EMAIL'), password: need(prefix + '_PASSWORD') });
}
const fail = (msg) => { console.error('ERROR: ' + String(msg).slice(0, 300)); process.exit(1); };
module.exports = { need, storeFor, fail };
