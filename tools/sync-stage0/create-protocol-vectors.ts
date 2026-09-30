// Run explicitly from root after changing a reviewed wire contract.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { canonicalStringify, operationAssociatedData, cryptoSuite, type UnsignedCommit } from '../../packages/sync-protocol/src';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = { '\uE000': 1, '🦁': 2, z: null, a: 0, text: 'á / 🦁 / e\u0301\n"\\', decimal64: '9007199254740993', items: [0, null, false] };
const canonical = canonicalStringify(input);
writeFileSync('packages/sync-protocol/fixtures/serialization.json', JSON.stringify({ input, canonical, utf8Hex: Buffer.from(canonical).toString('hex'), sha256: createHash('sha256').update(canonical).digest('hex') }, null, 2) + '\n');
const plaintext = {
  domainSchema: 1, entityType: 'transaction', action: 'put', authoredAt: '2026-09-30T12:00:00.000Z',
  provenance: { localScopeId: id(9), origin: 'local', legacyCreatedAt: null, legacyUpdatedAt: null, legacyDeletedAt: null },
  dependencies: [], restoredFrom: null,
  snapshot: { kind: 'expense', description: 'Café 🦁', categoryId: null, plannedAmountCents: 1234,
    actualAmountCents: 0, purchaseDate: null, dueDate: '2026-09-30', settledDate: '2026-09-30',
    status: 'paid', paymentMethodId: null, cardId: null, notes: 'á\nzero ≠ null', source: { type: 'manual' },
    installmentNumber: null, installmentTotal: null, occurrenceDate: null },
};
const commit: UnsignedCommit = { protocolVersion: 1, serverId: id(1), serverEpoch: id(2), vaultId: id(3),
  deviceId: id(4), deviceSeq: '9007199254740993', commitId: id(5), keyVersion: 1,
  deviceRegistryVersion: '1', cryptoSuite,
  operations: [{ opId: id(6), objectId: id(7), parents: [id(8)], nonce: Buffer.from(Array.from({ length: 24 }, (_, i) => i + 32)).toString('base64url'), ciphertext: '' }],
};
writeFileSync('packages/sync-protocol/fixtures/crypto-input.json', JSON.stringify({ plaintext, plaintextCanonical: canonicalStringify(plaintext), commit, aadCanonical: operationAssociatedData(commit, 0) }, null, 2) + '\n');
