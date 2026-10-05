import { equivalentMigrationHeads } from './financial';
import {
  assertDecimal64,
  assertManualTransactionRevision,
  assertFinancialRevision,
  assertSupportedRevision,
  canonicalStringify,
  type CommitEnvelope,
  type CommitReceipt,
  type RevisionPlaintext,
} from '@lionpocket/sync-protocol';
import {
  incrementDecimal64,
  recordManualMutation,
  type SqlRequest,
  type SqlRow,
  type SqlWorkflow,
} from './manual';
import { mergeFinancialGroups } from './merge';
import { causalCommonBase } from './causal-graph';
import { projectFinancial, resolveFinancial } from './financial-projection';
import type { ProvisionedProfile } from './provisioning';
export const sql = (
  sql: string,
  params?: SqlRequest['params'],
): SqlRequest => ({ sql, params });
export function compareDecimal(a: string, b: string) {
  assertDecimal64(a);
  assertDecimal64(b);
  return a.length === b.length
    ? a < b
      ? -1
      : a > b
        ? 1
        : 0
    : a.length < b.length
      ? -1
      : 1;
}
export interface LocalSyncDatabase {
  read(sql: string, params?: (string | number | null)[]): Promise<SqlRow[]>;
  run(workflow: SqlWorkflow): Promise<void>;
}
export type ProjectionDialect = 'desktop' | 'android';
export function* bindSynthetic(
  profile: ProvisionedProfile,
  endpoint: string,
  bindingId: string,
): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (
    !['synthetic_manual', 'financial'].includes(String(state.mode)) ||
    !state.local_scope_id ||
    state.binding_id
  )
    throw new Error('binding_unavailable');
  // A binding starts on a fresh synthetic lineage; no adoption of backups or untracked data.
  for (const table of [
    'transactions',
    'sync_revisions',
    'sync_outbox',
    'sync_inbox',
    'recurring_expenses',
    'installment_purchases',
    'goals',
  ]) {
    const [count] = yield sql(`SELECT COUNT(*) AS n FROM ${table}`);
    if (count.n !== 0) throw new Error('binding_requires_empty_database');
  }
  if (!profile.checkpoint || !profile.grants.length)
    throw new Error('trust_unavailable');
  const pin = profile.pin;
  yield sql('INSERT INTO sync_bindings VALUES(?,?,?,?,?,?,?,?,?,?)', [
    bindingId,
    String(state.local_scope_id),
    endpoint,
    pin.serverId,
    pin.serverEpoch,
    pin.vaultId,
    profile.deviceId,
    canonicalStringify(pin),
    canonicalStringify(profile.grants),
    canonicalStringify(profile.checkpoint),
  ]);
  yield sql(
    'UPDATE sync_local_state SET binding_id=?,server_id=?,server_epoch=?,vault_id=?,device_id=? WHERE id=1',
    [bindingId, pin.serverId, pin.serverEpoch, pin.vaultId, profile.deviceId],
  );
}
export function* updateRegistry(profile: ProvisionedProfile): SqlWorkflow {
  yield sql(
    'UPDATE sync_bindings SET registry_json=?,checkpoint_json=? WHERE device_id=? AND vault_id=?',
    [
      canonicalStringify(profile.grants),
      canonicalStringify(profile.checkpoint),
      profile.deviceId,
      profile.pin.vaultId,
    ],
  );
}
export function* persistPrepared(
  commitId: string,
  envelope: CommitEnvelope,
  digest: string,
  previousSeq: string,
): SqlWorkflow {
  const [row] = yield sql('SELECT * FROM sync_outbox WHERE commit_id=?', [
    commitId,
  ]);
  if (!row) throw new Error('outbox_missing');
  if (row.envelope_json !== null) return; // Another preparer already won; caller rereads the persisted bytes.
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (
    !['synthetic_manual', 'financial'].includes(String(state.mode)) ||
    state.device_seq !== previousSeq ||
    state.device_id !== envelope.deviceId ||
    state.vault_id !== envelope.vaultId ||
    state.server_epoch !== envelope.serverEpoch
  )
    throw new Error('binding_changed');
  yield sql(
    "UPDATE sync_outbox SET envelope_json=?,envelope_sha256=?,state='prepared',last_error=NULL WHERE commit_id=?",
    [canonicalStringify(envelope), digest, commitId],
  );
  yield sql('UPDATE sync_local_state SET device_seq=? WHERE id=1', [
    envelope.deviceSeq,
  ]);
  for (const op of envelope.operations)
    yield sql('INSERT INTO sync_revision_origin VALUES(?,?,?,?,NULL)', [
      op.opId,
      envelope.deviceId,
      envelope.deviceSeq,
      envelope.deviceRegistryVersion,
    ]);
}
export function* acknowledge(receipt: CommitReceipt): SqlWorkflow {
  yield sql(
    "UPDATE sync_outbox SET state='acknowledged',last_error=NULL,receipt_json=? WHERE commit_id=? AND envelope_sha256=?",
    [canonicalStringify(receipt), receipt.commitId, receipt.envelopeSha256],
  );
}
export function* receivePage(
  bindingId: string,
  priorCursor: string,
  upper: string,
  next: string,
  entries: {
    envelope: unknown;
    logPosition: string;
    acceptedRegistryVersion: string;
  }[],
  more: boolean,
): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (
    !['synthetic_manual', 'financial'].includes(String(state.mode)) ||
    state.binding_id !== bindingId ||
    state.received_cursor !== priorCursor ||
    (state.pull_upper_bound !== null && state.pull_upper_bound !== upper)
  )
    throw new Error('cursor_mismatch');
  for (const entry of entries) {
    const envelope = entry.envelope as CommitEnvelope;
    const text = canonicalStringify(envelope);
    const [existing] = yield sql('SELECT * FROM sync_inbox WHERE commit_id=?', [
      envelope.commitId,
    ]);
    if (
      existing &&
      (existing.envelope_json !== text ||
        existing.log_position !== entry.logPosition ||
        existing.accepted_registry_version !== entry.acceptedRegistryVersion)
    )
      throw new Error('idempotency_mismatch');
    if (!existing)
      yield sql("INSERT INTO sync_inbox VALUES(?,?,'received',?,NULL,?)", [
        envelope.commitId,
        entry.logPosition,
        text,
        entry.acceptedRegistryVersion,
      ]);
  }
  yield sql(
    'UPDATE sync_local_state SET received_cursor=?,pull_upper_bound=? WHERE id=1',
    [next, more ? upper : null],
  );
}
export interface DecodedOperation {
  opId: string;
  objectId: string;
  parents: string[];
  revision: RevisionPlaintext;
}
export function* applyCommit(
  envelope: CommitEnvelope,
  position: string,
  acceptedVersion: string,
  operations: DecodedOperation[],
  dialect: ProjectionDialect,
  uuid: () => string,
  projectionTime?: string,
): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (!['synthetic_manual', 'financial'].includes(String(state.mode)))
    throw new Error('sync_disabled');
  if (state.mode === 'financial')
    yield sql('UPDATE sync_control SET applying=1 WHERE id=1');
  let sequence = String(state.local_seq);
  const touched = new Set<string>();
  for (const op of operations) {
    assertSupportedRevision(op.revision, state.mode === 'financial');
    for (const dependency of op.revision.dependencies) {
      const [dep] = yield sql(
        'SELECT object_id FROM sync_revisions WHERE revision_id=?',
        [dependency.revisionId],
      );
      if (!dep) throw new Error('missing_dependencies');
      if (dep.object_id !== dependency.objectId)
        throw new Error('foreign_dependency');
    }
    const [known] = yield sql(
      'SELECT * FROM sync_revisions WHERE revision_id=?',
      [op.opId],
    );
    if (known) {
      if (
        known.object_id !== op.objectId ||
        known.commit_id !== envelope.commitId ||
        known.payload_json !== canonicalStringify(op.revision) ||
        known.parents_json !== canonicalStringify(op.parents)
      )
        throw new Error('idempotency_mismatch');
      yield sql(
        'UPDATE sync_revision_origin SET log_position=?,registry_version=? WHERE revision_id=?',
        [position, acceptedVersion, op.opId],
      );
      continue;
    }
    for (const parent of op.parents) {
      const [row] = yield sql(
        'SELECT object_id FROM sync_revisions WHERE revision_id=?',
        [parent],
      );
      if (!row) throw new Error('missing_parents');
      if (row.object_id !== op.objectId) throw new Error('foreign_parent');
    }
    const [identity] = yield sql(
      'SELECT local_id,entity_type FROM sync_identity WHERE object_id=?',
      [op.objectId],
    );
    if (!identity) {
      const slots =
        state.mode === 'financial'
          ? yield sql('SELECT local_id FROM sync_slots WHERE object_id=?', [
              op.objectId,
            ])
          : [];
      yield sql('INSERT INTO sync_identity VALUES(?,?,?)', [
        state.mode === 'financial'
          ? op.revision.entityType
          : 'manualTransaction',
        op.revision.entityType === 'recurringPriorityList'
          ? 'recurring-priorities'
          : op.revision.entityType === 'monthlyPriorityList' &&
              op.revision.action === 'put'
            ? String((op.revision.snapshot as { month: string }).month)
            : slots[0]
              ? String(slots[0].local_id)
              : uuid(),
        op.objectId,
      ]);
    }
    const tombstones = yield sql(
      'SELECT revision_id FROM sync_tombstones WHERE object_id=?',
      [op.objectId],
    );
    if (
      op.revision.action === 'put' &&
      tombstones.length &&
      op.parents.some((p) => tombstones.some((t) => t.revision_id === p))
    )
      throw new Error('tombstone_resurrection');
    sequence = incrementDecimal64(sequence);
    yield sql('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)', [
      op.opId,
      op.objectId,
      envelope.commitId,
      sequence,
      op.revision.action,
      op.revision.authoredAt,
      canonicalStringify(op.parents),
      canonicalStringify(op.revision),
    ]);
    yield sql('INSERT INTO sync_revision_origin VALUES(?,?,?,?,?)', [
      op.opId,
      envelope.deviceId,
      envelope.deviceSeq,
      acceptedVersion,
      position,
    ]);
    for (const parent of op.parents)
      yield sql('DELETE FROM sync_heads WHERE object_id=? AND revision_id=?', [
        op.objectId,
        parent,
      ]);
    yield sql('INSERT INTO sync_heads VALUES(?,?)', [op.objectId, op.opId]);
    if (op.revision.action === 'delete')
      yield sql('INSERT INTO sync_tombstones VALUES(?,?,?)', [
        op.objectId,
        op.opId,
        op.revision.deletedAt as string,
      ]);
    touched.add(op.objectId);
  }
  yield sql('UPDATE sync_local_state SET local_seq=? WHERE id=1', [sequence]);
  for (const id of touched)
    yield* projectObject(id, dialect, uuid, projectionTime);
  if (state.mode === 'financial')
    yield sql('UPDATE sync_control SET applying=0 WHERE id=1');
  yield sql(
    "UPDATE sync_inbox SET state='applied',last_error=NULL WHERE commit_id=?",
    [envelope.commitId],
  );
}
function commonBase(rows: SqlRow[], heads: string[]): string | null {
  const graph = new Map(
    rows.map((r) => [
      String(r.revision_id),
      JSON.parse(String(r.parents_json)) as string[],
    ]),
  );
  return causalCommonBase(
    new Map([...graph].map(([id, parents]) => [id, { parents }])),
    heads,
  );
}
export function* projectObject(
  objectId: string,
  dialect: ProjectionDialect,
  uuid: () => string,
  projectionTime?: string,
): SqlWorkflow {
  const headRows = yield sql(
    'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
    [objectId],
  );
  const heads = headRows.map((r) => String(r.revision_id));
  const [identity] = yield sql(
    'SELECT local_id,entity_type FROM sync_identity WHERE object_id=?',
    [objectId],
  );
  const tombstones = yield sql(
    'SELECT revision_id FROM sync_tombstones WHERE object_id=?',
    [objectId],
  );
  // A linear live object needs only its head payload, not repeated scans of its history.
  // Conflicts and tombstones still use the complete parent graph / historical delete rows.
  const rows = yield sql(
    heads.length <= 1 && !tombstones.length
      ? 'SELECT * FROM sync_revisions WHERE object_id=? AND revision_id=? AND revision_id NOT IN (SELECT revision_id FROM sync_rejected)'
      : 'SELECT * FROM sync_revisions WHERE object_id=? AND revision_id NOT IN (SELECT revision_id FROM sync_rejected)',
    heads.length <= 1 && !tombstones.length
      ? [objectId, heads[0] ?? '']
      : [objectId],
  );
  const [conflict] = yield sql(
    'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
    [objectId],
  );
  const base = heads.length > 1 ? commonBase(rows, heads) : heads[0];
  if (heads.length > 1) {
    if (conflict)
      yield sql(
        'UPDATE sync_conflicts SET heads_json=?,base_revision_id=? WHERE conflict_id=?',
        [canonicalStringify(heads), base, conflict.conflict_id],
      );
    else
      yield sql('INSERT INTO sync_conflicts VALUES(?,?,?,?,NULL)', [
        uuid(),
        objectId,
        canonicalStringify(heads),
        base,
      ]);
  } else if (conflict)
    yield sql('UPDATE sync_conflicts SET resolution_id=? WHERE conflict_id=?', [
      heads[0],
      conflict.conflict_id,
    ]);
  const row = rows.find((r) => r.revision_id === base);
  const revision = row
    ? (JSON.parse(String(row.payload_json)) as RevisionPlaintext)
    : null;
  const localId = String(identity.local_id);
  if (identity.entity_type !== 'manualTransaction') {
    const equivalentRoots =
      heads.length > 1 &&
      !revision &&
      (yield* equivalentMigrationHeads(objectId));
    if (heads.length > 1 && (!tombstones.length || equivalentRoots)) {
      const branches = heads.map(
        (h) =>
          JSON.parse(
            String(rows.find((r) => r.revision_id === h)?.payload_json),
          ) as RevisionPlaintext,
      );
      // Identical adoption roots carry one value, not competing edits. Different roots still conflict.
      const restoring = branches.some(
        (branch) => branch.provenance.origin === 'restore',
      );
      const merged = equivalentRoots
        ? {
            ...branches[0],
            authoredAt: projectionTime ?? new Date().toISOString(),
          }
        : restoring || !revision
          ? null
          : mergeFinancialGroups(
              revision,
              branches,
              projectionTime ?? new Date().toISOString(),
            );
      if (merged) {
        const [origin] = yield sql(
          'SELECT device_id FROM sync_revision_origin WHERE revision_id=?',
          [heads[0]],
        );
        const [state] = yield sql(
          'SELECT device_id FROM sync_local_state WHERE id=1',
        );
        if (!origin || origin.device_id === state.device_id) {
          yield* resolveFinancial(objectId, heads, merged, dialect, uuid);
          yield* projectObject(objectId, dialect, uuid, projectionTime);
          return;
        }
      }
    }
    const deletedRow = tombstones.length
      ? rows.find((r) => r.action === 'delete')
      : null;
    if (equivalentRoots)
      yield sql('UPDATE sync_conflicts SET resolution_id=? WHERE object_id=?', [
        heads[0],
        objectId,
      ]);
    const selected = deletedRow
      ? (JSON.parse(String(deletedRow.payload_json)) as RevisionPlaintext)
      : (revision ??
        (equivalentRoots
          ? (JSON.parse(
              String(
                rows.find((r) => r.revision_id === heads[0])?.payload_json,
              ),
            ) as RevisionPlaintext)
          : null));
    if (selected) yield* projectFinancial(localId, selected, dialect);
    else if (
      ['transaction', 'recurring', 'installmentPurchase', 'goal'].includes(
        String(identity.entity_type),
      )
    ) {
      const table = {
        transaction: 'transactions',
        recurring: 'recurring_expenses',
        installmentPurchase: 'installment_purchases',
        goal: 'goals',
      }[String(identity.entity_type) as 'transaction'];
      yield sql(`UPDATE ${table} SET deleted_at=? WHERE id=?`, [
        projectionTime ?? new Date().toISOString(),
        localId,
      ]);
    }
    return;
  }
  if (tombstones.length || !revision || revision.action === 'delete') {
    yield sql('DELETE FROM transaction_priority_order WHERE transaction_id=?', [
      localId,
    ]);
    yield sql('DELETE FROM transactions WHERE id=?', [localId]);
    return;
  }
  yield* projectSnapshot(localId, revision, dialect);
}
export function* projectSnapshot(
  localId: string,
  revision: RevisionPlaintext,
  dialect: ProjectionDialect,
): SqlWorkflow {
  if (revision.action !== 'put') throw new Error('invalid_projection');
  assertManualTransactionRevision(revision);
  const row = revision.snapshot;
  // assertManualTransactionRevision narrows semantics; the union still contains future DTOs statically.
  const s = row as import('@lionpocket/sync-protocol').TransactionSnapshot;
  const planned =
      dialect === 'desktop' ? 'planned_cents' : 'planned_amount_cents',
    actual = dialect === 'desktop' ? 'actual_cents' : 'actual_amount_cents';
  yield sql(
    `INSERT INTO transactions(id,kind,description,${planned},${actual},purchase_date,due_date,settled_date,status,notes,source_type,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'manual',?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,description=excluded.description,${planned}=excluded.${planned},${actual}=excluded.${actual},purchase_date=excluded.purchase_date,due_date=excluded.due_date,settled_date=excluded.settled_date,status=excluded.status,notes=excluded.notes,deleted_at=NULL,updated_at=excluded.updated_at`,
    [
      localId,
      s.kind,
      s.description,
      s.plannedAmountCents,
      s.actualAmountCents,
      s.purchaseDate,
      s.dueDate,
      s.settledDate,
      s.status,
      s.notes,
      revision.authoredAt,
      revision.authoredAt,
    ],
  );
}
export function* resolveConflict(
  objectId: string,
  expectedHeads: string[],
  choice: RevisionPlaintext,
  dialect: ProjectionDialect,
  uuid: () => string,
): SqlWorkflow {
  const [state] = yield sql('SELECT mode FROM sync_local_state WHERE id=1');
  if (state.mode === 'financial') {
    yield* resolveFinancial(objectId, expectedHeads, choice, dialect, uuid);
    yield* projectObject(objectId, dialect, uuid);
    return;
  }
  assertManualTransactionRevision(choice);
  const [identity] = yield sql(
    'SELECT local_id,entity_type FROM sync_identity WHERE object_id=?',
    [objectId],
  );
  const heads = yield sql(
    'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
    [objectId],
  );
  if (
    heads.length < 2 ||
    canonicalStringify(heads.map((h) => h.revision_id)) !==
      canonicalStringify(expectedHeads)
  )
    throw new Error('heads_changed');
  const deletes = yield sql(
    'SELECT revision_id FROM sync_tombstones WHERE object_id=?',
    [objectId],
  );
  if (choice.action === 'put' && deletes.length)
    throw new Error('deleted_object_requires_recovery');
  if (choice.action === 'put')
    yield* projectSnapshot(String(identity.local_id), choice, dialect);
  const localRow: SqlRow =
    choice.action === 'delete'
      ? {
          id: identity.local_id,
          source_type: 'manual',
          source_id: null,
          category_id: null,
          payment_method_id: null,
          card_id: null,
          installment_number: null,
          installment_total: null,
          occurrence_date: null,
          created_at: null,
          updated_at: null,
          deleted_at: choice.authoredAt,
        }
      : (yield sql(
          dialect === 'desktop'
            ? 'SELECT *,NULL AS occurrence_date FROM transactions WHERE id=?'
            : 'SELECT * FROM transactions WHERE id=?',
          [identity.local_id],
        ))[0];
  yield* recordManualMutation(localRow, uuid, choice.authoredAt, expectedHeads);
  yield* projectObject(objectId, dialect, uuid);
}
/** Recovery creates a new global identity, never a put descended from a tombstone. */
export function* recoverDeletedBranch(
  objectId: string,
  expectedHeads: string[],
  revisionId: string,
  dialect: ProjectionDialect,
  uuid: () => string,
  authoredAt: string,
): SqlWorkflow {
  const heads = yield sql(
    'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
    [objectId],
  );
  if (
    canonicalStringify(heads.map((h) => h.revision_id)) !==
    canonicalStringify(expectedHeads)
  )
    throw new Error('heads_changed');
  const tombstones = yield sql(
    'SELECT * FROM sync_tombstones WHERE object_id=?',
    [objectId],
  );
  if (!tombstones.length) throw new Error('recovery_requires_tombstone');
  const [row] = yield sql(
    'SELECT payload_json FROM sync_revisions WHERE revision_id=? AND object_id=?',
    [revisionId, objectId],
  );
  if (!row) throw new Error('revision_missing');
  const revision = JSON.parse(String(row.payload_json)) as RevisionPlaintext;
  if (revision.action !== 'put') throw new Error('recovery_requires_put');
  revision.authoredAt = authoredAt;
  const [state] = yield sql('SELECT mode FROM sync_local_state WHERE id=1');
  if (state.mode === 'financial') {
    yield* resolveFinancial(
      objectId,
      expectedHeads,
      revision,
      dialect,
      uuid,
      true,
    );
    return;
  }
  const id = uuid();
  yield* projectSnapshot(id, revision, dialect);
  const [localRow] = yield sql(
    dialect === 'desktop'
      ? 'SELECT *,NULL AS occurrence_date FROM transactions WHERE id=?'
      : 'SELECT * FROM transactions WHERE id=?',
    [id],
  );
  yield* recordManualMutation(localRow, uuid, authoredAt, undefined, objectId);
}
export interface ConflictReview {
  objectId: string;
  heads: string[];
  deleted: boolean;
  branches: { revisionId: string; revision: RevisionPlaintext }[];
}
export async function conflictReviews(
  db: LocalSyncDatabase,
): Promise<ConflictReview[]> {
  const rows = await db.read(
    'SELECT * FROM sync_conflicts WHERE resolution_id IS NULL',
  );
  const result: ConflictReview[] = [];
  for (const row of rows) {
    const heads = JSON.parse(String(row.heads_json)) as string[],
      branches: ConflictReview['branches'] = [];
    for (const id of heads) {
      const [r] = await db.read(
        'SELECT payload_json FROM sync_revisions WHERE revision_id=?',
        [id],
      );
      branches.push({
        revisionId: id,
        revision: JSON.parse(String(r.payload_json)) as RevisionPlaintext,
      });
    }
    result.push({
      objectId: String(row.object_id),
      heads,
      deleted:
        (
          await db.read(
            'SELECT revision_id FROM sync_tombstones WHERE object_id=?',
            [String(row.object_id)],
          )
        ).length > 0,
      branches,
    });
  }
  return result;
}
/** Stale resolution remains a draft; remove it from the active DAG before pulling new heads. */
export function* rejectResolution(
  commitId: string,
  dialect: ProjectionDialect,
  uuid: () => string,
): SqlWorkflow {
  const [row] = yield sql(
    'SELECT payload_json FROM sync_outbox WHERE commit_id=?',
    [commitId],
  );
  const pending = JSON.parse(String(row.payload_json)) as {
    operations: {
      opId: string;
      objectId: string;
      parents: string[];
      expectedHeads?: string[];
    }[];
  };
  for (const op of pending.operations) {
    if (!op.expectedHeads) continue;
    yield sql('INSERT OR IGNORE INTO sync_rejected VALUES(?,?)', [
      op.opId,
      'heads_changed',
    ]);
    yield sql('DELETE FROM sync_heads WHERE revision_id=?', [op.opId]);
    for (const parent of op.parents)
      yield sql('INSERT OR IGNORE INTO sync_heads VALUES(?,?)', [
        op.objectId,
        parent,
      ]);
    yield* projectObject(op.objectId, dialect, uuid);
  }
}
