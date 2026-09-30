// Same checks in Node, Electron main and Android/Hermes. No filesystem/network APIs.
async function runCryptoChecks(sodium, vector, serialization, protocol, sha256Hex, control, peer) {
  await sodium.ready;
  let checks = 0;
  const equal = (a, b, label) => { if (a !== b) throw new Error(label); checks++; };
  const bytes = (a, b, label) => equal(sodium.to_hex(a), sodium.to_hex(b), label);
  const rejected = (action, label) => {
    let rejected = false;
    try { const result = action(); rejected = result === false || result === null; } catch { rejected = true; }
    equal(rejected, true, label);
  };
  const fromHex = (text) => new Uint8Array(text.match(/../g).map((byte) => parseInt(byte, 16)));
  const b64 = (text) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
  const flip = (value) => { const copy = new Uint8Array(value); copy[0] ^= 1; return copy; };
  const { signature, ...commit } = vector.envelope;
  const plaintext = JSON.parse(vector.plaintextCanonical);
  equal(protocol.canonicalStringify(serialization.input), serialization.canonical, 'Canonical Unicode/integers');
  equal(sodium.to_hex(serialization.canonical), serialization.utf8Hex, 'Native UTF-8 Unicode bytes');
  equal(sha256Hex(fromHex(serialization.utf8Hex)), serialization.sha256, 'Serialization SHA-256');
  equal(protocol.canonicalStringify(plaintext), vector.plaintextCanonical, 'Canonical snapshot');
  equal(protocol.operationAssociatedData(commit, 0), vector.aadCanonical, 'AAD');
  equal(protocol.commitSigningInput(commit), vector.signingCanonical, 'Signing input');
  const op = commit.operations[0], key = fromHex(vector.keyHex), nonce = b64(op.nonce), cipher = b64(op.ciphertext);
  const message = vector.plaintextCanonical, aad = vector.aadCanonical;
  const encrypt = (m, a, n, k) => sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(m, a, null, n, k);
  const decrypt = (c, a, n, k) => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, c, a, n, k);
  bytes(encrypt(message, aad, nonce, key), cipher, 'AEAD ciphertext exact');
  equal(sodium.to_string(decrypt(cipher, aad, nonce, key)), message, 'AEAD open');
  // Subarray views must not accidentally consume the underlying buffer/padding.
  const paddedKey = new Uint8Array(34); paddedKey.set(key, 1);
  bytes(encrypt(message, aad, nonce, paddedKey.subarray(1, 33)), cipher, 'Uint8Array byteOffset');
  for (const args of [[flip(cipher), aad, nonce, key], [cipher, aad + '!', nonce, key], [cipher, aad, flip(nonce), key], [cipher, aad, nonce, flip(key)], [cipher.slice(0, -1), aad, nonce, key]])
    rejected(() => decrypt(...args), 'AEAD tamper/truncation');
  for (const field of ['protocolVersion', 'serverId', 'serverEpoch', 'vaultId', 'deviceId', 'deviceSeq', 'commitId', 'keyVersion', 'deviceRegistryVersion', 'cryptoSuite']) {
    const changed = { ...commit, [field]: field === 'keyVersion' ? 2 : 'modified' };
    rejected(() => decrypt(cipher, protocol.operationAssociatedData(changed, 0), nonce, key), 'AAD ' + field);
  }
  for (const change of [{ opId: commit.commitId }, { objectId: commit.vaultId }, { parents: [] }, { expectedHeads: op.parents }])
    rejected(() => decrypt(cipher, protocol.operationAssociatedData({ ...commit, operations: [{ ...op, ...change }] }, 0), nonce, key), 'Operation AAD');
  rejected(() => decrypt(cipher, protocol.operationAssociatedData({ ...commit, operations: [op, op] }, 1), nonce, key), 'Position/count AAD');
  const pair = sodium.crypto_sign_seed_keypair(fromHex(vector.signSeedHex));
  equal(sodium.to_hex(pair.publicKey), vector.signPublicKeyHex, 'Ed25519 public key');
  bytes(sodium.crypto_sign_detached(vector.signingCanonical, pair.privateKey), b64(signature), 'Ed25519 exact signature');
  equal(sodium.crypto_sign_verify_detached(b64(signature), vector.signingCanonical, pair.publicKey), true, 'Ed25519 verify');
  rejected(() => sodium.crypto_sign_verify_detached(b64(signature).slice(0, -1), vector.signingCanonical, pair.publicKey), 'Signature truncation');
  equal(sodium.crypto_sign_verify_detached(flip(b64(signature)), vector.signingCanonical, pair.publicKey), false, 'Signature tamper');
  equal(sodium.crypto_sign_verify_detached(b64(signature), vector.signingCanonical + '!', pair.publicKey), false, 'Signing payload tamper');
  const box = sodium.crypto_box_seed_keypair(fromHex(vector.boxSeedHex));
  equal(sodium.to_hex(box.publicKey), vector.boxPublicKeyHex, 'X25519 public key');
  equal(sodium.to_hex(box.privateKey), vector.boxSecretKeyHex, 'X25519 secret key format');
  equal(sodium.to_string(sodium.crypto_box_seal_open(b64(vector.sealedBox), box.publicKey, box.privateKey)), vector.keyBundleCanonical, 'C sealed box open');
  rejected(() => sodium.crypto_box_seal_open(flip(b64(vector.sealedBox)), box.publicKey, box.privateKey), 'Sealed box tamper');
  const wrong = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(255));
  rejected(() => sodium.crypto_box_seal_open(b64(vector.sealedBox), wrong.publicKey, wrong.privateKey), 'Sealed box wrong recipient');
  const randomA = sodium.randombytes_buf(32), randomB = sodium.randombytes_buf(32);
  equal(randomA.byteLength, 32, 'Native randombytes length');
  equal(sodium.to_hex(randomA) !== sodium.to_hex(randomB), true, 'Native randombytes fresh sample');
  equal(sha256Hex(fromHex(sodium.to_hex(protocol.canonicalStringify(vector.envelope)))), vector.envelopeSha256Hex, 'Envelope SHA-256');
  if (peer) equal(sodium.to_string(sodium.crypto_box_seal_open(b64(peer.sealedBox), box.publicKey, box.privateKey)), vector.keyBundleCanonical, 'Peer sealed box open');
  if (control) {
    const authority = sodium.crypto_sign_seed_keypair(fromHex(control.authoritySeedHex));
    equal(sodium.to_hex(authority.publicKey), control.authorityPublicKeyHex, 'Authority Ed25519 key');
    for (const [item, name, helper, signer] of [
      [control.approved, 'grant', protocol.deviceGrantSigningInput, authority],
      [control.revoked, 'grant', protocol.deviceGrantSigningInput, authority],
      [control.delivery, 'delivery', protocol.keyDeliverySigningInput, pair],
    ]) {
      const { signature: sig, ...unsigned } = item[name];
      equal(helper(unsigned), item.signingCanonical, 'Control signing input');
      bytes(sodium.crypto_sign_detached(item.signingCanonical, signer.privateKey), b64(sig), 'Control signature exact');
      equal(sodium.crypto_sign_verify_detached(b64(sig), item.signingCanonical, signer.publicKey), true, 'Control signature verify');
      equal(sodium.crypto_sign_verify_detached(b64(sig), item.signingCanonical, signer === authority ? pair.publicKey : authority.publicKey), false, 'Control wrong authority');
      for (const field of Object.keys(unsigned))
        equal(sodium.crypto_sign_verify_detached(b64(sig), helper({ ...unsigned, [field]: 'changed' }), signer.publicKey), false, 'Control field ' + field);
    }
    equal(sha256Hex(fromHex(sodium.to_hex(protocol.canonicalStringify(control.approved.grant)))), sodium.to_hex(b64(control.revoked.grant.previousRegistrySha256)), 'Registry predecessor hash');
    const r = control.recovery, master = fromHex(r.masterHex);
    equal(r.code, 'LP1.' + sodium.to_base64(master, sodium.base64_variants.URLSAFE_NO_PADDING), 'Recovery code format');
    const derived = sodium.crypto_kdf_derive_from_key(32, 1, 'LPRECOV1', master);
    equal(sodium.to_hex(derived), r.derivedKeyHex, 'Native BLAKE2b KDF exact');
    const { ciphertext, ...header } = r.envelope;
    equal(protocol.recoveryAssociatedData(header), r.aadCanonical, 'Recovery AAD');
    bytes(encrypt(r.bundleCanonical, r.aadCanonical, b64(header.nonce), derived), b64(ciphertext), 'Recovery AEAD exact');
    equal(sodium.to_string(decrypt(b64(ciphertext), r.aadCanonical, b64(header.nonce), derived)), r.bundleCanonical, 'Recovery bundle open');
    for (const field of Object.keys(header))
      rejected(() => decrypt(b64(ciphertext), protocol.recoveryAssociatedData({ ...header, [field]: 'changed' }), b64(header.nonce), derived), 'Recovery AAD ' + field);
    rejected(() => decrypt(flip(b64(ciphertext)), r.aadCanonical, b64(header.nonce), derived), 'Recovery ciphertext tamper');
    for (const wrong of [sodium.crypto_kdf_derive_from_key(32, 1, 'LPRECOV1', flip(master)), sodium.crypto_kdf_derive_from_key(32, 2, 'LPRECOV1', master), sodium.crypto_kdf_derive_from_key(32, 1, 'LPRECOV2', master)])
      rejected(() => decrypt(b64(ciphertext), r.aadCanonical, b64(header.nonce), wrong), 'Recovery KDF separation/wrong code');
  }
  return { result: 'PASS' , checks, sealedBox: sodium.to_base64(sodium.crypto_box_seal(vector.keyBundleCanonical, box.publicKey), sodium.base64_variants.URLSAFE_NO_PADDING) };
}
module.exports = { runCryptoChecks };
