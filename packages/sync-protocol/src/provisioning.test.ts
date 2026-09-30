import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertHttpProof,
  assertPairingRequest,
  httpProofSigningInput,
  pairingFingerprintInput,
  pairingSigningInput,
  verifyHttpProof,
  verifyPairing,
} from './provisioning';
import { canonicalStringify } from './canonical';
import { decodeCanonical } from './decoder';
const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/provisioning.json', import.meta.url),
    'utf8',
  ),
);
const publicKey = (key: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(key, 'base64url'),
    ]),
    type: 'spki',
    format: 'der',
  });
const crypto = {
  hash: (text: string) => createHash('sha256').update(text).digest('base64url'),
  verify: (signature: string, text: string, key: string) =>
    verify(
      null,
      Buffer.from(text),
      publicKey(key),
      Buffer.from(signature, 'base64url'),
    ),
};
describe('frozen provisioning bytes verified by OpenSSL', () => {
  it('reproduces pairing fields, fingerprint and detached signature', () => {
    const { signature, fingerprint, ...fields } = fixture.request;
    assertPairingRequest(fixture.request);
    expect(pairingFingerprintInput(fields)).toBe(fixture.fingerprintCanonical);
    expect(crypto.hash(fixture.fingerprintCanonical)).toBe(fingerprint);
    expect(pairingSigningInput({ ...fields, fingerprint })).toBe(
      fixture.pairingCanonical,
    );
    expect(
      crypto.verify(
        signature,
        fixture.pairingCanonical,
        fields.signingPublicKey,
      ),
    ).toBe(true);
    verifyPairing(fixture.request, crypto);
  });
  it('reproduces HTTP signature bytes and body/token digests', () => {
    const { signature, ...unsigned } = fixture.proof;
    assertHttpProof(fixture.proof);
    expect(httpProofSigningInput(unsigned)).toBe(fixture.proofCanonical);
    expect(
      crypto.verify(
        signature,
        fixture.proofCanonical,
        fixture.request.signingPublicKey,
      ),
    ).toBe(true);
    verifyHttpProof(
      fixture.proof,
      {
        scope: fixture.request,
        method: 'POST',
        target: unsigned.target,
        origin: unsigned.origin,
        body: canonicalStringify(fixture.request),
        token: 'PUBLIC-SYNTHETIC-TOKEN-NOT-A-JWT',
        now: unsigned.issuedAt,
        publicKey: fixture.request.signingPublicKey,
      },
      crypto,
    );
    expect(
      decodeCanonical(Buffer.from(canonicalStringify(fixture.proof))),
    ).toEqual(fixture.proof);
  });
  it('every unsigned field participates in its signature', () => {
    for (const value of [fixture.request, fixture.proof]) {
      const { signature, ...unsigned } = value;
      for (const key of Object.keys(unsigned)) {
        const changed = {
          ...unsigned,
          [key]:
            typeof unsigned[key] === 'number'
              ? unsigned[key] + 1
              : unsigned[key] + 'x',
        };
        const input =
          'fingerprint' in unsigned
            ? pairingSigningInput(changed)
            : httpProofSigningInput(changed);
        expect(
          crypto.verify(signature, input, fixture.request.signingPublicKey),
        ).toBe(false);
      }
    }
  });
});
