import { isValidDate } from '@lionpocket/core';
import { canonicalStringify } from './canonical';
import {
  cryptoSuite,
  type CommitEnvelope,
  type TransactionSnapshot,
  type RevisionPlaintext,
} from './types';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object.');
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new Error('Unexpected or missing field.');
}
export function assertUuid(
  value: unknown,
  versions = '45',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !new RegExp(
      `^[0-9a-f]{8}-[0-9a-f]{4}-[${versions}][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    ).test(value)
  )
    throw new Error('Expected canonical UUID.');
}
export function assertDecimal64(
  value: unknown,
  positive = false,
): asserts value is string {
  const limit = '9223372036854775807';
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > limit.length ||
    (value.length === limit.length && value > limit) ||
    (positive && value === '0')
  )
    throw new Error('Expected decimal int64 string.');
}
export function assertBase64Url(
  value: unknown,
  byteLength?: number,
  minimumBytes = 0,
): asserts value is string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  )
    throw new Error('Expected unpadded base64url.');
  const rest = value.length % 4,
    last = alphabet.indexOf(value[value.length - 1]);
  if ((rest === 2 && (last & 15) !== 0) || (rest === 3 && (last & 3) !== 0))
    throw new Error('Noncanonical base64url.');
  const bytes = Math.floor((value.length * 6) / 8);
  if (
    (byteLength !== undefined && bytes !== byteLength) ||
    bytes < minimumBytes
  )
    throw new Error('Invalid byte length.');
}
function assertIdSet(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error('Expected ID set.');
  value.forEach((id, index) => {
    assertUuid(id, '4');
    if (index > 0 && value[index - 1] >= id)
      throw new Error('ID set must be sorted and unique.');
  });
}
export function assertCommitEnvelope(
  value: unknown,
): asserts value is CommitEnvelope {
  canonicalStringify(value); // Reject non-JSON, floats and lossy JS values before inspecting.
  const commit = record(value);
  exactKeys(commit, [
    'protocolVersion',
    'serverId',
    'serverEpoch',
    'vaultId',
    'deviceId',
    'deviceSeq',
    'commitId',
    'keyVersion',
    'deviceRegistryVersion',
    'cryptoSuite',
    'operations',
    'signature',
  ]);
  if (commit.protocolVersion !== 1 || commit.cryptoSuite !== cryptoSuite)
    throw new Error('Unsupported version or suite.');
  for (const key of [
    'serverId',
    'serverEpoch',
    'vaultId',
    'deviceId',
    'commitId',
  ])
    assertUuid(commit[key], '4');
  assertDecimal64(commit.deviceSeq, true);
  assertDecimal64(commit.deviceRegistryVersion, true);
  if (!Number.isSafeInteger(commit.keyVersion) || Number(commit.keyVersion) < 1)
    throw new Error('Invalid key version.');
  assertBase64Url(commit.signature, 64);
  if (!Array.isArray(commit.operations) || !commit.operations.length)
    throw new Error('Empty commit.');
  const seen = new Set<string>();
  for (const value of commit.operations) {
    const op = record(value);
    exactKeys(
      op,
      ['opId', 'objectId', 'parents', 'nonce', 'ciphertext'],
      ['expectedHeads'],
    );
    assertUuid(op.opId, '4');
    assertUuid(op.objectId);
    if (seen.has(op.opId)) throw new Error('Repeated operation ID.');
    seen.add(op.opId);
    assertIdSet(op.parents);
    if (op.parents.includes(op.opId)) throw new Error('Self parent.');
    if ('expectedHeads' in op) {
      assertIdSet(op.expectedHeads);
      if (
        !op.expectedHeads.length ||
        canonicalStringify(op.expectedHeads) !== canonicalStringify(op.parents)
      )
        throw new Error(
          'Resolution must reference exactly the reviewed heads.',
        );
    }
    assertBase64Url(op.nonce, 24);
    assertBase64Url(op.ciphertext, undefined, 16);
  }
  // Signature verification, graph ownership, registry trust and payload quotas belong to adapters/engine.
}
/** Only the Stage 1 pilot scope; the other DTOs remain contracts, not enabled capabilities. */
export function assertManualTransactionSnapshot(
  value: unknown,
): asserts value is TransactionSnapshot {
  canonicalStringify(value);
  const row = record(value);
  exactKeys(row, [
    'kind',
    'description',
    'categoryId',
    'plannedAmountCents',
    'actualAmountCents',
    'purchaseDate',
    'dueDate',
    'settledDate',
    'status',
    'paymentMethodId',
    'cardId',
    'notes',
    'source',
    'installmentNumber',
    'installmentTotal',
    'occurrenceDate',
  ]);
  if (!['income', 'expense'].includes(String(row.kind)))
    throw new Error('Invalid kind.');
  if (
    typeof row.description !== 'string' ||
    !row.description.trim() ||
    typeof row.notes !== 'string'
  )
    throw new Error('Invalid text.');
  for (const key of ['plannedAmountCents', 'actualAmountCents']) {
    if (key === 'actualAmountCents' && row[key] === null) continue;
    if (
      typeof row[key] !== 'number' ||
      !Number.isSafeInteger(row[key]) ||
      Number(row[key]) < 0
    )
      throw new Error('Invalid cents.');
  }
  if (typeof row.dueDate !== 'string' || !isValidDate(row.dueDate))
    throw new Error('Invalid due date.');
  for (const key of ['purchaseDate', 'settledDate'])
    if (
      row[key] !== null &&
      (typeof row[key] !== 'string' || !isValidDate(row[key] as string))
    )
      throw new Error('Invalid date.');
  if (
    !['planned', 'paid', 'received', 'cancelled'].includes(
      String(row.status),
    ) ||
    (row.status === 'paid' && row.kind !== 'expense') ||
    (row.status === 'received' && row.kind !== 'income')
  )
    throw new Error('Invalid status.');
  const settled = row.status === 'paid' || row.status === 'received';
  if (settled === (row.settledDate === null))
    throw new Error('Status/date mismatch.');
  for (const key of [
    'categoryId',
    'paymentMethodId',
    'cardId',
    'installmentNumber',
    'installmentTotal',
    'occurrenceDate',
  ])
    if (row[key] !== null) throw new Error('Outside manual pilot scope.');
  const source = record(row.source);
  exactKeys(source, ['type']);
  if (source.type !== 'manual') throw new Error('Outside manual pilot scope.');
}

export function assertManualTransactionRevision(
  value: unknown,
): asserts value is RevisionPlaintext {
  canonicalStringify(value);
  const revision = record(value);
  const metadata = [
    'domainSchema',
    'entityType',
    'action',
    'authoredAt',
    'provenance',
    'dependencies',
    'restoredFrom',
    'snapshot',
  ];
  if (revision.domainSchema !== 1 || revision.entityType !== 'transaction')
    throw new Error('Unsupported domain scope.');
  if (revision.action !== 'put' && revision.action !== 'delete')
    throw new Error('Invalid action.');
  exactKeys(
    revision,
    revision.action === 'put'
      ? metadata
      : [...metadata, 'reason', 'deletedAt', 'slotKey', 'importKey'],
  );
  const instant = (value: unknown) => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      throw new Error('Expected UTC instant.');
  };
  instant(revision.authoredAt);
  if (revision.restoredFrom !== null) assertUuid(revision.restoredFrom);
  const provenance = record(revision.provenance);
  exactKeys(provenance, [
    'localScopeId',
    'origin',
    'legacyCreatedAt',
    'legacyUpdatedAt',
    'legacyDeletedAt',
  ]);
  assertUuid(provenance.localScopeId, '4');
  if (
    !['local', 'migration', 'import', 'restore'].includes(
      String(provenance.origin),
    )
  )
    throw new Error('Invalid provenance.');
  for (const key of ['legacyCreatedAt', 'legacyUpdatedAt', 'legacyDeletedAt'])
    if (provenance[key] !== null && typeof provenance[key] !== 'string')
      throw new Error('Invalid legacy audit value.');
  if (!Array.isArray(revision.dependencies) || revision.dependencies.length)
    throw new Error('Outside manual pilot scope.');
  if (revision.action === 'put')
    assertManualTransactionSnapshot(revision.snapshot);
  else {
    if (
      revision.snapshot !== null ||
      revision.reason !== 'user' ||
      revision.slotKey !== null ||
      revision.importKey !== null
    )
      throw new Error('Invalid manual tombstone.');
    instant(revision.deletedAt);
  }
}
/** Receipt parsing alone never acknowledges an outbox; callers also compare the immutable header/digest. */
export function assertCommitReceipt(
  value: unknown,
): asserts value is import('./types').CommitReceipt {
  canonicalStringify(value);
  const r = record(value);
  exactKeys(r, [
    'serverId',
    'serverEpoch',
    'vaultId',
    'commitId',
    'deviceId',
    'deviceSeq',
    'result',
    'logPosition',
    'acceptedRegistryVersion',
    'envelopeSha256',
    'heads',
  ]);
  for (const key of [
    'serverId',
    'serverEpoch',
    'vaultId',
    'commitId',
    'deviceId',
  ])
    assertUuid(r[key], '4');
  for (const key of ['deviceSeq', 'logPosition', 'acceptedRegistryVersion'])
    assertDecimal64(r[key], true);
  if (r.result !== 'accepted') throw new Error('Invalid receipt result.');
  assertBase64Url(r.envelopeSha256, 32);
  if (!Array.isArray(r.heads) || !r.heads.length || r.heads.length > 100)
    throw new Error('Invalid receipt heads.');
  const heads = r.heads;
  heads.forEach((value, index) => {
    const h = record(value);
    exactKeys(h, ['objectId', 'revisionIds']);
    assertUuid(h.objectId);
    assertIdSet(h.revisionIds);
    if (
      !h.revisionIds.length ||
      (index && String(record(heads[index - 1]).objectId) >= h.objectId)
    )
      throw new Error('Invalid receipt heads.');
  });
}
