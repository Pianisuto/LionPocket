import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertEpochRecoveryChallenge, assertEpochRecoveryAuthorization, epochRecoverySigningInput,
  verifyEpochRecoveryAuthorization } from './epoch-recovery';
import { canonicalStringify } from './canonical';
import { decodeCanonical } from './decoder';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/epoch-recovery.json', import.meta.url), 'utf8'));
const key = (text: string) => createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(text, 'base64url'),
]) });
const crypto = { hash: (text: string) => createHash('sha256').update(text).digest('base64url'),
  verify: (sig: string, text: string, pk: string) => verify(null, Buffer.from(text), key(pk), Buffer.from(sig, 'base64url')) };
const pin = { serverId: fixture.challenge.serverId, serverEpoch: fixture.challenge.fromEpoch, vaultId: fixture.challenge.vaultId,
  authorityPublicKey: fixture.challenge.authorityPublicKey, founderDeviceId: fixture.challenge.challengeId, keyVersion: 1 };
const expected = { pin, challenge: fixture.challenge, knownRegistry: fixture.authorization.knownRegistry };
describe('epoch preparation authorization byte contract (not an activation)', () => {
  it('freezes UTF-8, canonical bytes, digest and Ed25519 verified independently with OpenSSL', () => {
    const { signature, ...unsigned } = fixture.authorization;
    assertEpochRecoveryChallenge(fixture.challenge); assertEpochRecoveryAuthorization(fixture.authorization);
    expect(epochRecoverySigningInput(unsigned)).toBe(fixture.signingCanonical);
    expect(Buffer.from(fixture.signingCanonical).toString('hex')).toBe(fixture.signingUtf8Hex);
    expect(crypto.hash(canonicalStringify(fixture.authorization))).toBe(fixture.authorizationSha256);
    expect(crypto.verify(signature, fixture.signingCanonical, pin.authorityPublicKey)).toBe(true);
    verifyEpochRecoveryAuthorization(fixture.authorization, expected, crypto);
    expect(decodeCanonical(Buffer.from(canonicalStringify(fixture.authorization)))).toEqual(fixture.authorization);
    expect(() => epochRecoverySigningInput(fixture.authorization)).toThrow('unsigned');
  });
  it('authenticates every field, including server/vault/epochs/restore/challenge/checkpoints/state and format', () => {
    for (const field of Object.keys(fixture.authorization).filter(k => k !== 'signature')) {
      const changed = { ...fixture.authorization, [field]: null };
      expect(() => verifyEpochRecoveryAuthorization(changed, expected, crypto)).toThrow();
    }
    for (const field of ['version', 'sha256']) {
      const changed = { ...fixture.authorization, knownRegistry: { ...fixture.authorization.knownRegistry, [field]: 'bad' } };
      expect(() => verifyEpochRecoveryAuthorization(changed, expected, crypto)).toThrow();
    }
  });
  it('requires external pin/checkpoint; refuses authority substitution, wrong scope and a replaced challenge', () => {
    for (const field of ['serverId', 'serverEpoch', 'vaultId', 'authorityPublicKey'])
      expect(() => verifyEpochRecoveryAuthorization(fixture.authorization, { ...expected, pin: { ...pin, [field]: field === 'authorityPublicKey' ? 'A'.repeat(43) : fixture.challenge.restoreId } }, crypto)).toThrow();
    expect(() => verifyEpochRecoveryAuthorization(fixture.authorization, { ...expected, knownRegistry: fixture.challenge.restoredRegistry }, crypto)).toThrow();
    expect(() => verifyEpochRecoveryAuthorization(fixture.authorization, { ...expected, challenge: { ...fixture.challenge, restoreId: fixture.challenge.challengeId } }, crypto)).toThrow();
    expect(crypto.verify(fixture.authorization.signature, fixture.signingCanonical.replace('epoch-recovery-authorization', 'epoch-transition'), pin.authorityPublicKey)).toBe(false);
  });
  it('rejects unsigned, future format, same-epoch, extra fields and noncanonical wire', () => {
    const { signature, ...unsigned } = fixture.authorization; void signature;
    for (const value of [unsigned, { ...fixture.authorization, financialPlaintext: 'canary' }, { ...fixture.authorization, formatVersion: 2 }])
      expect(() => assertEpochRecoveryAuthorization(value)).toThrow();
    expect(() => assertEpochRecoveryChallenge({ ...fixture.challenge, toEpoch: fixture.challenge.fromEpoch })).toThrow();
    expect(() => decodeCanonical(Buffer.from(JSON.stringify(fixture.authorization, null, 2)))).toThrow();
  });
});
