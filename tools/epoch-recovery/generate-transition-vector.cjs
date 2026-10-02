// Public deterministic test key ONLY. OpenSSL signs independently of the sodium adapters.
const { createHash, createPrivateKey, sign } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { canonicalStringify, epochBaselineManifestInput, epochTransitionSigningInput, epochTransitionDigest } = require('../../packages/sync-protocol/dist');
const preparation = JSON.parse(readFileSync(join(__dirname, '../../packages/sync-protocol/fixtures/epoch-recovery.json'), 'utf8'));
const { authorization: a } = preparation;
const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(preparation.publicTestSeedHex, 'hex'),
]) });
const crypto = { hash: text => createHash('sha256').update(text).digest('base64url') };
const hash = v => crypto.hash(canonicalStringify(v));
const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const fromPin = { serverId: a.serverId, serverEpoch: a.fromEpoch, vaultId: a.vaultId,
  authorityPublicKey: a.authorityPublicKey, founderDeviceId: id(11), keyVersion: 1 };
const toPin = { ...fromPin, serverEpoch: a.toEpoch, founderDeviceId: id(12) };
// Commitment fixtures, not production registry/checkpoint/recovery envelopes.
const registry = { checkpoint: { version: '1', sha256: crypto.hash('registry fixture') } };
const keyCheckpoint = { keyVersion: 2, commitment: crypto.hash('checkpoint fixture') };
const recovery = { commitment: crypto.hash('encrypted recovery fixture') };
const manifest = { formatVersion: 1, serverId: a.serverId, vaultId: a.vaultId, serverEpoch: a.toEpoch,
  restoreId: a.restoreId, anchorDeviceId: toPin.founderDeviceId, authorizationSha256: hash(a),
  registrySha256: hash(registry), keyCheckpointSha256: hash(keyCheckpoint), recoverySha256: hash(recovery),
  archiveSha256: crypto.hash('archive fixture'), mappingSha256: crypto.hash('mapping fixture'),
  commitCount: '9007199254740993', operationCount: '9007199254740994', batchCount: '9007199254740992',
  envelopesSha256: crypto.hash('ordered envelopes fixture'), headsSha256: crypto.hash('public heads fixture') };
const unsigned = { formatVersion: 1, serverId: a.serverId, vaultId: a.vaultId,
  fromEpoch: a.fromEpoch, toEpoch: a.toEpoch, restoreId: a.restoreId, authorityPublicKey: a.authorityPublicKey,
  authorizationSha256: manifest.authorizationSha256, restoredStateSha256: a.restoredStateSha256,
  manifestSha256: crypto.hash(epochBaselineManifestInput(manifest)), trustPinSha256: hash(toPin),
  registrySha256: manifest.registrySha256, keyCheckpointSha256: manifest.keyCheckpointSha256,
  recoverySha256: manifest.recoverySha256, archiveSha256: manifest.archiveSha256,
  mappingSha256: manifest.mappingSha256, previousTransitionSha256: null };
const signingCanonical = epochTransitionSigningInput(unsigned);
const transition = { ...unsigned, signature: sign(null, Buffer.from(signingCanonical), privateKey).toString('base64url') };
writeFileSync(join(__dirname, '../../packages/sync-protocol/fixtures/epoch-transition.json'), JSON.stringify({
  publicTestSeedHex: preparation.publicTestSeedHex, authorization: a, fromPin, toPin, registry, keyCheckpoint,
  recovery, manifest, manifestCanonical: epochBaselineManifestInput(manifest), transition, signingCanonical,
  signingUtf8Hex: Buffer.from(signingCanonical).toString('hex'), transitionSha256: epochTransitionDigest(transition, crypto),
}, null, 2) + '\n');
