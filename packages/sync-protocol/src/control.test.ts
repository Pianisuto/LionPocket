import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalStringify, deviceGrantSigningInput, keyDeliverySigningInput, recoveryAssociatedData } from './index';
const control = JSON.parse(readFileSync(`${process.cwd()}/fixtures/control.json`, 'utf8'));
const crypto = JSON.parse(readFileSync(`${process.cwd()}/fixtures/crypto.json`, 'utf8'));
const publicKey = (hex: string) => createPublicKey({ format: 'der', type: 'spki',
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]) });
describe('contratos de controle offline', () => {
  for (const [name, field, signingInput, key] of [
    ['approved', 'grant', deviceGrantSigningInput, control.authorityPublicKeyHex],
    ['revoked', 'grant', deviceGrantSigningInput, control.authorityPublicKeyHex],
    ['delivery', 'delivery', keyDeliverySigningInput, crypto.signPublicKeyHex],
  ] as const) {
    it(`congela bytes e verifica autoria e todos os campos de ${name} com OpenSSL`, () => {
      const { signature, ...unsigned } = control[name][field];
      const input = signingInput(unsigned);
      expect(input).toBe(control[name].signingCanonical);
      const sig = Buffer.from(signature, 'base64url'), pk = publicKey(key);
      expect(verify(null, Buffer.from(input), pk, sig)).toBe(true);
      for (const property of Object.keys(unsigned))
        expect(verify(null, Buffer.from(signingInput({ ...unsigned, [property]: 'changed' })), pk, sig)).toBe(false);
      expect(verify(null, Buffer.from(input), publicKey(name === 'delivery' ? control.authorityPublicKeyHex : crypto.signPublicKeyHex), sig)).toBe(false);
      expect(() => signingInput(control[name][field])).toThrow('unsigned');
    });
  }
  it('vincula o predecessor inteiro com assinatura à cadeia de registro', () => {
    expect(control.approved.grant.previousRegistrySha256).toBe(null);
    expect(createHash('sha256').update(canonicalStringify(control.approved.grant)).digest('base64url'))
      .toBe(control.revoked.grant.previousRegistrySha256);
  });
  it('recovery separa AAD e cifra, vincula todos os campos e mantém segredo de autoridade e histórico', () => {
    const r = control.recovery, { ciphertext, ...header } = r.envelope;
    expect(recoveryAssociatedData(header)).toBe(r.aadCanonical);
    for (const key of Object.keys(header)) expect(recoveryAssociatedData({ ...header, [key]: 'changed' })).not.toBe(r.aadCanonical);
    expect(() => recoveryAssociatedData(r.envelope)).toThrow('header');
    expect(Buffer.from(ciphertext, 'base64url').length).toBe(Buffer.byteLength(r.bundleCanonical) + 16);
    expect(r.code).toBe('LP1.' + Buffer.from(r.masterHex, 'hex').toString('base64url'));
    expect(JSON.parse(r.bundleCanonical)).toMatchObject({ authorityPublicKey: Buffer.from(control.authorityPublicKeyHex, 'hex').toString('base64url'), activeKeyVersion: 1, dataKeys: [{ keyVersion: 1 }] });
  });
});
