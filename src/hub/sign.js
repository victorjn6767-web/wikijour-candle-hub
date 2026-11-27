'use strict';
// Ed25519 manifest signing. The signing key is independent of every Supabase credential and exists only in the publishing environment.
const crypto = require('crypto');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
function newKeyPair() { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; }
function keyId(publicPem) { return sha256(crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' })).slice(0, 16); }
function sign(manifestBytes, privatePem) {
  const priv = crypto.createPrivateKey(privatePem);
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  return Buffer.from(JSON.stringify({ alg: 'ed25519', keyId: keyId(pub), manifestSha256: sha256(manifestBytes), sig: crypto.sign(null, manifestBytes, priv).toString('base64') }) + '\n');
}
// trusted: { [keyId]: publicPem } (pinned in the app/Worker). Returns true or throws.
function verify(manifestBytes, sigBytes, trusted) {
  if (sigBytes.length > 2048) throw new Error('signature document too large');
  let d; try { d = JSON.parse(sigBytes.toString('utf8')); } catch (e) { throw new Error('signature document is not JSON'); }
  if (d.alg !== 'ed25519') throw new Error('unsupported signature algorithm');
  const pem = trusted && Object.prototype.hasOwnProperty.call(trusted, d.keyId) ? trusted[d.keyId] : null; if (!pem) throw new Error('unknown signing key');
  if (d.manifestSha256 !== sha256(manifestBytes)) throw new Error('manifest hash mismatch');
  const sig = Buffer.from(String(d.sig), 'base64'); if (sig.length !== 64) throw new Error('bad signature length');
  if (!crypto.verify(null, manifestBytes, crypto.createPublicKey(pem), sig)) throw new Error('bad signature');
  return true;
}
module.exports = { newKeyPair, keyId, sign, verify, sha256 };
