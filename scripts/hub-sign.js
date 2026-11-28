'use strict';
// Sign job (environment hub-sign): promote the candidate manifest to the signed, published manifest, then verify it exactly as the app will.
// Env: HUB_SIGNING_KEY (PEM, secret). The key is only passed to the signer in memory; it is never written to disk or printed.
const fs = require('fs'), path = require('path');
const { finalize, gc } = require('../src/hub/publish'), { HubReader } = require('../src/hub/verify'), { keyId } = require('../src/hub/sign'), { storeFor, fail, need } = require('../src/hub/env');
(async () => {
  const pem = need('HUB_SIGNING_KEY');
  const trusted = JSON.parse(fs.readFileSync(process.env.HUB_TRUSTED_FILE || path.join(__dirname, '..', 'keys', 'trusted.json'), 'utf8'));
  if (!Object.keys(trusted).length) fail('keys/trusted.json has no public key yet: run scripts/hub-keygen.js and commit the public part first');
  const crypto = require('crypto'); const pub = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'pem' });
  if (!trusted[keyId(pub)]) fail('the signing key is not listed in keys/trusted.json (wrong key or file not updated)');
  const store = storeFor('HUB_WRITER'), r = await finalize({ store, privatePem: pem });
  const rd = new HubReader({ read: (p, max) => store.get('hub', p, max), trusted });
  const m = await rd.manifest(); let months = 0;
  for (const [sym, s] of Object.entries(m.symbols)) for (const mo of Object.keys(s.months)) { await rd.month(sym, mo); months++; }
  const g = await gc({ store, manifestBytes: await store.get('hub', 'manifest.json') });
  console.log(`published manifest seq=${r.seq}; reader-side verification passed for ${months} month file(s); old versions deleted: ${g.deleted}`);
})().catch(e => fail((e && e.message) || e));
