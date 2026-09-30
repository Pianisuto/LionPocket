// Isolated spike. Argument: directory containing the temporary npm installation.
// No production dependencies; run after npm run build:contracts.
const { createRequire } = require('node:module');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
if (!process.argv[2]) throw new Error('Pass the isolated npm directory.');
const requireSpike = createRequire(resolve(process.argv[2], 'package.json'));
const sodium = requireSpike('libsodium-wrappers-sumo');
const protocol = require('../../packages/sync-protocol/dist');
const vector = JSON.parse(readFileSync(resolve(__dirname, '../../packages/sync-protocol/fixtures/crypto.json'), 'utf8'));
const b64 = (s) => sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
const flip = (b) => { const copy = new Uint8Array(b); copy[0] ^= 1; return copy; };
(async () => {
  await sodium.ready;
  const { signature, ...commit } = vector.envelope;
  protocol.assertCommitEnvelope(vector.envelope);
  const plaintext = JSON.parse(vector.plaintextCanonical);
  protocol.assertManualTransactionSnapshot(plaintext.snapshot);
  assert.equal(protocol.canonicalStringify(plaintext), vector.plaintextCanonical);
  assert.equal(protocol.operationAssociatedData(commit, 0), vector.aadCanonical);
  assert.equal(protocol.commitSigningInput(commit), vector.signingCanonical);
  const op = commit.operations[0], key = sodium.from_hex(vector.keyHex), nonce = b64(op.nonce), cipher = b64(op.ciphertext);
  const message = sodium.from_string(vector.plaintextCanonical), aad = sodium.from_string(vector.aadCanonical);
  assert.deepEqual(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, null, nonce, key), cipher);
  assert.deepEqual(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, aad, nonce, key), message);
  for (const args of [[flip(cipher), aad, nonce, key], [cipher, flip(aad), nonce, key], [cipher, aad, flip(nonce), key], [cipher, aad, nonce, flip(key)]]) {
    assert.throws(() => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ...args));
  }
  const pair = sodium.crypto_sign_seed_keypair(sodium.from_hex(vector.signSeedHex));
  assert.equal(sodium.to_hex(pair.publicKey), vector.signPublicKeyHex);
  assert.deepEqual(sodium.crypto_sign_detached(vector.signingCanonical, pair.privateKey), b64(signature));
  assert.equal(sodium.crypto_sign_verify_detached(b64(signature), vector.signingCanonical, pair.publicKey), true);
  assert.equal(sodium.crypto_sign_verify_detached(flip(b64(signature)), vector.signingCanonical, pair.publicKey), false);
  assert.equal(sodium.crypto_sign_verify_detached(b64(signature), vector.signingCanonical + '!', pair.publicKey), false);
  const box = sodium.crypto_box_seed_keypair(sodium.from_hex(vector.boxSeedHex));
  assert.equal(sodium.to_hex(box.publicKey), vector.boxPublicKeyHex);
  assert.equal(sodium.to_hex(box.privateKey), vector.boxSecretKeyHex);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(b64(vector.sealedBox), box.publicKey, box.privateKey)), vector.keyBundleCanonical);
  assert.throws(() => sodium.crypto_box_seal_open(flip(b64(vector.sealedBox)), box.publicKey, box.privateKey));
  const wrong = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(255));
  assert.throws(() => sodium.crypto_box_seal_open(b64(vector.sealedBox), wrong.publicKey, wrong.privateKey));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ sealedBox: sodium.to_base64(sodium.crypto_box_seal(vector.keyBundleCanonical, box.publicKey), sodium.base64_variants.URLSAFE_NO_PADDING) }));
  assert.equal(createHash('sha256').update(protocol.canonicalStringify(vector.envelope)).digest('hex'), vector.envelopeSha256Hex);
  console.log(JSON.stringify({ runtime: 'Node ' + process.version + ' / libsodium-wrappers-sumo 0.8.4', libsodium: sodium.sodium_version_string(), result: 'PASS', checks: 'portable serialization/AAD/signing, exact AEAD/Ed25519 bytes + tamper, native sealed box open + tamper/wrong key, SHA-256' }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
