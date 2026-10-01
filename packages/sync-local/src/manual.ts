import {
  assertDecimal64,
  assertManualTransactionRevision,
  assertUuid,
  canonicalStringify,
  type RevisionPlaintext,
  type TransactionSnapshot,
} from '@lionpocket/sync-protocol';
export type SqlRow = Record<string, string | number | null>;
export interface SqlRequest {
  sql: string;
  params?: (string | number | null)[];
}
export type SqlWorkflow = Generator<SqlRequest, void, SqlRow[]>;
const query = (
  sql: string,
  params?: (string | number | null)[],
): SqlRequest => ({ sql, params });
/** Decimal arithmetic stays textual, including above MAX_SAFE_INTEGER; exhaustion rolls back. */
export function incrementDecimal64(value: string): string {
  assertDecimal64(value);
  const digits = value.split('');
  let carry = 1;
  for (let i = digits.length - 1; i >= 0 && carry; i--) {
    const next = Number(digits[i]) + carry;
    digits[i] = String(next % 10);
    carry = next > 9 ? 1 : 0;
  }
  if (carry) digits.unshift('1');
  const result = digits.join('');
  assertDecimal64(result, true);
  return result;
}
/** Test-only opt-in, before any financial data. No remote binding or capabilities enabled. */
export function* activateSyntheticManualPilot(uuid: () => string): SqlWorkflow {
  const [state] = yield query('SELECT * FROM sync_local_state WHERE id = 1');
  if (!state || state.mode !== 'disabled' || state.local_scope_id !== null)
    throw new Error('Pilot already initialized.');
  for (const table of [
    'transactions',
    'recurring_expenses',
    'installment_purchases',
    'goals',
    'sync_identity',
    'sync_revisions',
    'sync_outbox',
    'sync_inbox',
  ]) {
    const [count] = yield query(`SELECT COUNT(*) AS count FROM ${table}`);
    if (count.count !== 0)
      throw new Error('Synthetic pilot requires an empty financial database.');
  }
  const scope = uuid();
  assertUuid(scope, '4');
  yield query(
    "UPDATE sync_local_state SET local_scope_id = ?, mode = 'synthetic_manual' WHERE id = 1",
    [scope],
  );
}
export function inManualScope(row: SqlRow): boolean {
  return (
    row.source_type === 'manual' &&
    [
      'source_id',
      'category_id',
      'payment_method_id',
      'card_id',
      'installment_number',
      'installment_total',
      'occurrence_date',
    ].every((k) => row[k] === null)
  );
}
function snapshot(row: SqlRow): TransactionSnapshot {
  return {
    kind: row.kind as TransactionSnapshot['kind'],
    description: String(row.description),
    plannedAmountCents: Number(row.planned_cents ?? row.planned_amount_cents),
    actualAmountCents: (row.actual_cents ?? row.actual_amount_cents ?? null) as
      number | null,
    purchaseDate: row.purchase_date as string | null,
    dueDate: String(row.due_date),
    settledDate: row.settled_date as string | null,
    status: row.status as TransactionSnapshot['status'],
    notes: String(row.notes),
    categoryId: null,
    paymentMethodId: null,
    cardId: null,
    source: { type: 'manual' },
    installmentNumber: null,
    installmentTotal: null,
    occurrenceDate: null,
  };
}
/** Run entirely on the caller's transaction handle, after its financial mutation. */
export function* recordManualMutation(
  row: SqlRow,
  uuid: () => string,
  authoredAt: string,
  expectedHeads?: string[],
  restoredFrom: string | null = null,
): SqlWorkflow {
  const [state] = yield query('SELECT * FROM sync_local_state WHERE id = 1');
  if (!state) throw new Error('Missing local sync state.');
  if (state.mode !== 'synthetic_manual') return;
  const [identity] = yield query(
    "SELECT object_id FROM sync_identity WHERE entity_type = 'manualTransaction' AND local_id = ?",
    [row.id],
  );
  if (!inManualScope(row)) {
    if (identity)
      throw new Error('Tracked manual transaction cannot leave pilot scope.');
    return; // Other domains remain local.
  }
  const objectId = identity ? String(identity.object_id) : uuid();
  assertUuid(objectId, '4');
  const heads = yield query(
    'SELECT revision_id FROM sync_heads WHERE object_id = ? ORDER BY revision_id',
    [objectId],
  );
  if (
    expectedHeads &&
    (!expectedHeads.length ||
      canonicalStringify(expectedHeads) !==
        canonicalStringify(heads.map((head) => String(head.revision_id))))
  )
    throw new Error('heads_changed');
  if (heads.length > 1 && !expectedHeads)
    throw new Error('Manual conflict requires explicit resolution.');
  for (const head of heads) {
    const [pendingResolution] = yield query(
      "SELECT payload_json FROM sync_outbox WHERE commit_id=(SELECT commit_id FROM sync_revisions WHERE revision_id=?) AND state!='acknowledged'",
      [head.revision_id],
    );
    if (
      pendingResolution &&
      (
        JSON.parse(String(pendingResolution.payload_json)) as {
          operations: { expectedHeads?: string[] }[];
        }
      ).operations.some((op) => op.expectedHeads)
    )
      throw new Error('resolution_pending_receipt');
  }
  const parents = heads.map((head) => String(head.revision_id));
  const revisionId = uuid(),
    commitId = uuid();
  assertUuid(revisionId, '4');
  assertUuid(commitId, '4');
  const sequence = incrementDecimal64(String(state.local_seq));
  const metadata = {
    domainSchema: 1 as const,
    entityType: 'transaction' as const,
    authoredAt,
    provenance: {
      localScopeId: String(state.local_scope_id),
      origin: 'local' as const,
      legacyCreatedAt: row.created_at as string | null,
      legacyUpdatedAt: row.updated_at as string | null,
      legacyDeletedAt: row.deleted_at as string | null,
    },
    dependencies: [],
    restoredFrom,
  };
  const revision: RevisionPlaintext =
    row.deleted_at !== null
      ? {
          ...metadata,
          action: 'delete',
          snapshot: null,
          reason: 'user',
          deletedAt: authoredAt,
          slotKey: null,
          importKey: null,
        }
      : { ...metadata, action: 'put', snapshot: snapshot(row) };
  assertManualTransactionRevision(revision);
  const payload = canonicalStringify(revision);
  const pending = canonicalStringify({
    formatVersion: 1,
    commitId,
    localSeq: sequence,
    operations: [
      {
        opId: revisionId,
        objectId,
        parents,
        ...(expectedHeads ? { expectedHeads } : {}),
        revision,
      },
    ],
  });
  // No wire envelope until a future explicit binding supplies trust/keys/header.
  if (!identity)
    yield query("INSERT INTO sync_identity VALUES('manualTransaction', ?, ?)", [
      row.id,
      objectId,
    ]);
  yield query('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)', [
    revisionId,
    objectId,
    commitId,
    sequence,
    revision.action,
    authoredAt,
    canonicalStringify(parents),
    payload,
  ]);
  yield query('DELETE FROM sync_heads WHERE object_id = ?', [objectId]);
  yield query('INSERT INTO sync_heads VALUES(?,?)', [objectId, revisionId]);
  if (revision.action === 'delete')
    yield query('INSERT INTO sync_tombstones VALUES(?,?,?)', [
      objectId,
      revisionId,
      authoredAt,
    ]);
  yield query(
    "INSERT INTO sync_outbox(commit_id,local_seq,state,payload_json,envelope_json,envelope_sha256,last_error) VALUES(?,?,'pending',?,NULL,NULL,NULL)",
    [commitId, sequence, pending],
  );
  yield query('UPDATE sync_local_state SET local_seq = ? WHERE id = 1', [
    sequence,
  ]);
}
