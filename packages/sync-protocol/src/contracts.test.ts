import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertCommitEnvelope, assertManualTransactionSnapshot, assertManualTransactionRevision, assertUuid, assertDecimal64, assertBase64Url,
  canonicalStringify, operationAssociatedData, commitSigningInput, stage0Capabilities } from './index';
const fixture = (name: string) => JSON.parse(readFileSync(`${process.cwd()}/fixtures/${name}.json`, 'utf8'));
const serialization = fixture('serialization'), crypto = fixture('crypto');
const plaintext = JSON.parse(crypto.plaintextCanonical);
const { signature, ...unsigned } = crypto.envelope;
describe('contratos offline v1', () => {
  it('não anuncia escopo nem sync ativo', () => {
    expect(stage0Capabilities).toMatchObject({ syncEnabled: false, entityScopes: [] });
  });
  it('conserva bytes UTF-8, ordem UTF-16 das chaves, Unicode, zero, null e int64 string', () => {
    expect(canonicalStringify(serialization.input)).toBe(serialization.canonical);
    const bytes = Buffer.from(canonicalStringify(serialization.input), 'utf8');
    expect(bytes.toString('hex')).toBe(serialization.utf8Hex);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(serialization.sha256);
    expect(canonicalStringify({ ...serialization.input, items: [0, null, false] })).toBe(serialization.canonical);
    expect(canonicalStringify({ value: 'é' })).not.toBe(canonicalStringify({ value: 'e\u0301' }));
  });
  it.each([undefined, NaN, Infinity, -0, 1.23, 9007199254740992, BigInt(1), new Date(), '\ud800', '\udfff', [undefined], new Array(1), { a: undefined }])('rejeita valores não representáveis sem perda: %s', (value) => {
    expect(() => canonicalStringify(value)).toThrow();
  });
  it('rejeita ciclos, getters e chaves adicionais em arrays', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow();
    expect(() => canonicalStringify({ get value() { throw new Error('must not execute'); } })).toThrow('Accessor');
    expect(() => canonicalStringify(Object.assign([], { extra: 1 }))).toThrow('Extra');
    expect(() => canonicalStringify(Object.defineProperty({}, 'hidden', { value: 1 }))).toThrow('Hidden');
    const array = [0];
    Object.defineProperty(array, '0', { enumerable: true, get() { throw new Error('must not execute'); } });
    expect(() => canonicalStringify(array)).toThrow('Accessor');
  });
  it('verifica vetor de envelope, AAD, assinatura Ed25519 com OpenSSL e hash', () => {
    assertCommitEnvelope(crypto.envelope);
    assertManualTransactionRevision(plaintext);
    expect(operationAssociatedData(unsigned, 0)).toBe(crypto.aadCanonical);
    expect(commitSigningInput(unsigned)).toBe(crypto.signingCanonical);
    expect(createHash('sha256').update(canonicalStringify(crypto.envelope)).digest('hex')).toBe(crypto.envelopeSha256Hex);
    const pk = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(crypto.signPublicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(commitSigningInput(unsigned)), pk, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from(commitSigningInput({ ...unsigned, keyVersion: 2 })), pk, Buffer.from(signature, 'base64url'))).toBe(false);
    expect(() => commitSigningInput(crypto.envelope)).toThrow('unsigned');
    expect(() => operationAssociatedData(crypto.envelope, 0)).toThrow('unsigned');
  });
  it.each(['serverId', 'serverEpoch', 'vaultId', 'deviceId', 'commitId', 'deviceSeq', 'keyVersion', 'deviceRegistryVersion'])('vincula %s ao AAD', (field) => {
    const changed = { ...unsigned, [field]: field === 'keyVersion' ? 2 : 'different' };
    expect(operationAssociatedData(changed, 0)).not.toBe(crypto.aadCanonical);
  });
  it('vincula posição, quantidade, identidade, pais, nonce e resolução ao AAD', () => {
    const op = unsigned.operations[0];
    for (const [field, value] of Object.entries({ objectId: unsigned.vaultId, opId: unsigned.commitId, parents: [], nonce: 'different', expectedHeads: op.parents }))
      expect(operationAssociatedData({ ...unsigned, operations: [{ ...op, [field]: value }] }, 0)).not.toBe(crypto.aadCanonical);
    expect(operationAssociatedData({ ...unsigned, operations: [op, op] }, 0)).not.toBe(crypto.aadCanonical);
    expect(operationAssociatedData({ ...unsigned, operations: [op, op] }, 0)).not.toBe(operationAssociatedData({ ...unsigned, operations: [op, op] }, 1));
  });
  it('aceita zero e null distintos; rejeita campos de UI, reais, referências e origens fora do piloto', () => {
    const snapshot = plaintext.snapshot;
    assertManualTransactionSnapshot(snapshot);
    assertManualTransactionSnapshot({ ...snapshot, actualAmountCents: null });
    expect(canonicalStringify(snapshot)).not.toBe(canonicalStringify({ ...snapshot, actualAmountCents: null }));
    for (const change of [{ plannedAmountCents: -1 }, { actualAmountCents: 1.5 }, { categoryName: 'JOIN' }, { actualAmount: 12.34 }, { settledDate: null }, { kind: 'income' }, { dueDate: 'pending-id' }, { categoryId: unsigned.vaultId }, { source: { type: 'imported' } }])
      expect(() => assertManualTransactionSnapshot({ ...snapshot, ...change })).toThrow();
  });
  it('exclusão contém tombstone explícito, sem snapshot nem dependências no piloto', () => {
    const deleted = { ...plaintext, action: 'delete', snapshot: null, reason: 'user', deletedAt: plaintext.authoredAt, slotKey: null, importKey: null };
    assertManualTransactionRevision(deleted);
    for (const change of [{ snapshot: plaintext.snapshot }, { reason: 'cache' }, { deletedAt: '2026-09-30 12:00:00' }, { dependencies: [{ objectId: unsigned.vaultId }] }, { domainSchema: 2 }])
      expect(() => assertManualTransactionRevision({ ...deleted, ...change })).toThrow();
  });
  it('IDs locais e decimal/base64 não canônicos não passam por IDs globais', () => {
    for (const id of ['cat-food', '0123456789abcdef0123456789abcdef', unsigned.vaultId.toUpperCase().replace('0000', 'ABCD')]) expect(() => assertUuid(id)).toThrow();
    for (const number of [42, '01', '-1', '9223372036854775808']) expect(() => assertDecimal64(number)).toThrow();
    assertDecimal64('9007199254740993');
    for (const encoded of ['YQ==', 'YR', 'Y', '++//']) expect(() => assertBase64Url(encoded)).toThrow();
    assertBase64Url('YQ', 1);
  });
  it('rejeita pais duplicados, autoparentes, op repetida, suite futura e assinatura curta', () => {
    const op = crypto.envelope.operations[0];
    for (const change of [{ parents: [op.parents[0], op.parents[0]] }, { parents: [op.opId] }, { expectedHeads: [] }, { expectedHeads: [unsigned.commitId] }, { nonce: 'YQ' }])
      expect(() => assertCommitEnvelope({ ...crypto.envelope, operations: [{ ...op, ...change }] })).toThrow();
    for (const change of [{ operations: [op, op] }, { protocolVersion: 2 }, { signature: 'YQ' }, { deviceSeq: '0' }, { plaintext: 'leak' }])
      expect(() => assertCommitEnvelope({ ...crypto.envelope, ...change })).toThrow();
  });
});
