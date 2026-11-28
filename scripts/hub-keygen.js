'use strict';
// Creates the Ed25519 manifest signing key pair ON YOUR OWN MACHINE. Offline: no network, no Supabase credential involved.
// The PRIVATE key is written to a file (mode 0600) and is never printed. Only the public key and its id are printed.
// Usage: node scripts/hub-keygen.js <private-key-output-file>        (the file must not exist and should live OUTSIDE this repository)
const fs = require('fs'), path = require('path');
const { newKeyPair, keyId } = require('../src/hub/sign');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/hub-keygen.js <private-key-output-file>'); process.exit(2); }
const abs = path.resolve(out), repo = path.resolve(__dirname, '..');
if (fs.existsSync(abs)) { console.error('refusing to overwrite an existing file'); process.exit(2); }
if (abs === repo || abs.startsWith(repo + path.sep)) { console.error('refusing to write the private key inside the repository'); process.exit(2); }
const { publicPem, privatePem } = newKeyPair();
fs.writeFileSync(abs, privatePem, { mode: 0o600, flag: 'wx' });
const id = keyId(publicPem);
console.log(`private key written to: ${abs} (mode 600). It is NOT shown here. Put its full contents into the GitHub Environment secret HUB_SIGNING_KEY (environment: hub-sign), then keep one offline backup.`);
console.log(`key id: ${id}`);
console.log('\nPublic part: replace the content of keys/trusted.json with exactly this and commit it (public, safe):\n');
console.log(JSON.stringify({ [id]: publicPem }, null, 2));
