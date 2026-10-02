import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './canonical';
import { assertEpochBaselineManifest, assertEpochTransition, epochBaselineManifestInput,
  epochTransitionDigest, epochTransitionSigningInput, verifyEpochTransition, type EpochTransition } from './epoch-transition';
import { epochRecoverySigningInput } from './epoch-recovery';
const f = JSON.parse(readFileSync(new URL('../fixtures/epoch-transition.json', import.meta.url), 'utf8'));
const crypto = { hash: (text: string) => createHash('sha256').update(text).digest('base64url'),
  verify: (signature: string, text: string, pk: string) => verify(null, Buffer.from(text), createPublicKey({
    format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pk, 'base64url')]),
  }), Buffer.from(signature, 'base64url')) };
const expected = { fromPin: f.fromPin, toPin: f.toPin, authorization: f.authorization, manifest: f.manifest,
  registry: f.registry, keyCheckpoint: f.keyCheckpoint, recovery: f.recovery, previousTransition: null };
const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(f.publicTestSeedHex, 'hex'),
]) });
describe('final epoch authority proof (commitments, not activation permission)', () => {
  it('fixes canonical bytes, digest and domain with an independent OpenSSL vector', () => {
    const { signature, ...unsigned } = f.transition;
    expect(epochTransitionSigningInput(unsigned)).toBe(f.signingCanonical);
    expect(Buffer.from(f.signingCanonical).toString('hex')).toBe(f.signingUtf8Hex);
    expect(epochBaselineManifestInput(f.manifest)).toBe(f.manifestCanonical);
    expect(epochTransitionDigest(f.transition, crypto)).toBe(f.transitionSha256);
    expect(crypto.verify(signature, f.signingCanonical, f.fromPin.authorityPublicKey)).toBe(true);
    verifyEpochTransition(f.transition, expected, crypto);
    expect(() => epochTransitionSigningInput(f.transition)).toThrow('unsigned');
    expect(() => assertEpochTransition(f.authorization)).toThrow();
    expect(() => verifyEpochTransition({ ...f.transition, signature: f.authorization.signature }, expected, crypto)).toThrow('invalid_signature');
  });
  it('authenticates every transition and manifest field and all supplied artifacts', () => {
    for (const field of Object.keys(f.transition))
      expect(() => verifyEpochTransition({ ...f.transition, [field]: f.transition[field] === null ? 'A'.repeat(43) : null }, expected, crypto)).toThrow();
    for (const field of Object.keys(f.manifest))
      expect(() => verifyEpochTransition(f.transition, { ...expected, manifest: { ...f.manifest, [field]: null } }, crypto)).toThrow();
    for (const field of ['registry', 'keyCheckpoint', 'recovery', 'toPin', 'authorization'] as const)
      expect(() => verifyEpochTransition(f.transition, { ...expected, [field]: {} }, crypto)).toThrow();
    expect(() => verifyEpochTransition({ ...f.transition, extra: true }, expected, crypto)).toThrow();
  });
  it('binds the chain tip for A→B→C and refuses omission, fork or skipping B', () => {
    const hash = (v: unknown) => crypto.hash(canonicalStringify(v));
    const pinC = { ...f.toPin, serverEpoch: '00000013-1111-4111-8111-111111111111', founderDeviceId: '00000014-1111-4111-8111-111111111111' };
    const { signature: oldSignature, ...oldAuthorization } = f.authorization; void oldSignature;
    const unsignedAuthorization = { ...oldAuthorization, fromEpoch: f.toPin.serverEpoch, toEpoch: pinC.serverEpoch,
      restoreId: '00000015-1111-4111-8111-111111111111' };
    const authorization = { ...unsignedAuthorization, signature: sign(null, Buffer.from(epochRecoverySigningInput(unsignedAuthorization)), privateKey).toString('base64url') };
    const manifest = { ...f.manifest, serverEpoch: pinC.serverEpoch, restoreId: authorization.restoreId,
      anchorDeviceId: pinC.founderDeviceId, authorizationSha256: hash(authorization) };
    const { signature, ...base } = f.transition; void signature;
    const unsigned = { ...base, fromEpoch: f.toPin.serverEpoch, toEpoch: pinC.serverEpoch, restoreId: authorization.restoreId,
      authorizationSha256: hash(authorization), manifestSha256: crypto.hash(epochBaselineManifestInput(manifest)),
      trustPinSha256: hash(pinC), previousTransitionSha256: f.transitionSha256 };
    const transition: EpochTransition = { ...unsigned, signature: sign(null, Buffer.from(epochTransitionSigningInput(unsigned)), privateKey).toString('base64url') };
    const next = { ...expected, fromPin: f.toPin, toPin: pinC, authorization, manifest, previousTransition: f.transition };
    verifyEpochTransition(transition, next, crypto);
    expect(() => verifyEpochTransition(transition, { ...next, previousTransition: null }, crypto)).toThrow();
    expect(() => verifyEpochTransition(transition, { ...next, fromPin: f.fromPin }, crypto)).toThrow();
    expect(() => verifyEpochTransition(transition, { ...next, previousTransition: { ...f.transition, signature: 'A'.repeat(86) } }, crypto)).toThrow();
    expect(() => verifyEpochTransition({ ...transition, previousTransitionSha256: null }, next, crypto)).toThrow();
  });
  it('rejects same-epoch, invalid counts, missing/extra fields and unsafe numbers', () => {
    expect(() => assertEpochTransition({ ...f.transition, toEpoch: f.transition.fromEpoch })).toThrow();
    for (const changes of [{ commitCount: 1 }, { commitCount: '0' }, { operationCount: '1' }, { batchCount: '9223372036854775808' }, { formatVersion: 2 }])
      expect(() => assertEpochBaselineManifest({ ...f.manifest, ...changes })).toThrow();
  });
});
