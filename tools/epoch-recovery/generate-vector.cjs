// Public deterministic test keys ONLY. Never imported by apps/server.
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { epochRecoverySigningInput, canonicalStringify } = require('../../packages/sync-protocol/dist');
const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const challenge = { formatVersion: 1, serverId: id(1), vaultId: id(2), fromEpoch: id(3), toEpoch: id(4),
  authorityPublicKey: publicKey, restoreId: id(5), challengeId: id(6), nonce: Buffer.alloc(32, 7).toString('base64url'),
  restoredRegistry: { version: '1', sha256: Buffer.alloc(32, 8).toString('base64url') },
  restoredStateSha256: Buffer.alloc(32, 9).toString('base64url'), expiresAt: 1790870400000 };
const unsigned = { ...challenge, intent: 'prepare-recovery', knownRegistry: { version: '9007199254740993', sha256: Buffer.alloc(32, 10).toString('base64url') } };
const signingCanonical = epochRecoverySigningInput(unsigned);
const authorization = { ...unsigned, signature: sign(null, Buffer.from(signingCanonical), privateKey).toString('base64url') };
writeFileSync(join(__dirname, '../../packages/sync-protocol/fixtures/epoch-recovery.json'), JSON.stringify({ publicTestSeedHex: seed.toString('hex'),
  challenge, authorization, signingCanonical, signingUtf8Hex: Buffer.from(signingCanonical).toString('hex'),
  authorizationSha256: createHash('sha256').update(canonicalStringify(authorization)).digest('base64url') }, null, 2) + '\n');
