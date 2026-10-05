import { isValidDate } from '@lionpocket/core';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import {
  assertFinancialRevision,
  assertUuid,
  canonicalStringify,
  encodeUtf8,
  type EntityType,
  type RevisionPlaintext,
  type Snapshots,
} from '@lionpocket/sync-protocol';
import { incrementDecimal64, type SqlRow, type SqlWorkflow } from './manual';
import { financialTableTypes } from './schema';
import type { ProvisionedProfile } from './provisioning';
const sql = (sql: string, params?: (string | number | null)[]) => ({
  sql,
  params,
});
export function derivedId(namespace: string, name: string): string {
  assertUuid(namespace);
  const hex = namespace.replace(/-/g, '');
  const ns = Uint8Array.from(hex.match(/../g) as string[], (b) =>
    parseInt(b, 16),
  );
  const text = encodeUtf8(name),
    bytes = new Uint8Array(ns.length + text.length);
  bytes.set(ns);
  bytes.set(text, ns.length);
  const digest = sha1(bytes).slice(0, 16);
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const h = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function importDigest(value: unknown): string {
  return Array.from(sha256(encodeUtf8(canonicalStringify(value))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
const tableFor = (type: EntityType) =>
  Object.entries(financialTableTypes).find(
    ([, t]) => t === type,
  )?.[0] as string;
export function* identityFor(
  type: EntityType,
  localId: string,
  uuid: () => string,
  namespace?: string,
): Generator<ReturnType<typeof sql>, string, SqlRow[]> {
  const [identity] = yield sql(
    'SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?',
    [type, localId],
  );
  if (identity) return String(identity.object_id);
  const [state] = yield sql('SELECT vault_id FROM sync_local_state WHERE id=1');
  const imported =
    type === 'transaction'
      ? yield sql(
          'SELECT import_key FROM sync_import_provenance WHERE local_id=?',
          [localId],
        )
      : [];
  const receipt = (yield sql(
    "SELECT payload_json FROM sync_review WHERE reason LIKE 'import_receipt:%'",
  ))
    .map(
      (r) =>
        JSON.parse(String(r.payload_json)) as {
          entityType: string;
          localId: string;
          importKey: string;
        },
    )
    .find((r) => r.entityType === type && r.localId === localId);
  const id =
    receipt && state.vault_id
      ? derivedId(String(state.vault_id), `import:v1:${receipt.importKey}`)
      : imported.length && state.vault_id
        ? derivedId(
            String(state.vault_id),
            `import:v1:${imported[0].import_key}`,
          )
        : namespace
          ? derivedId(namespace, `${type}:${localId}`)
          : uuid();
  assertUuid(id);
  yield sql('INSERT INTO sync_identity VALUES(?,?,?)', [type, localId, id]);
  return id;
}
export function* localReference(
  id: string | null,
): Generator<ReturnType<typeof sql>, string | null, SqlRow[]> {
  if (id === null) return null;
  const [alias] = yield sql(
    'SELECT object_id FROM sync_aliases WHERE alias_id=?',
    [id],
  );
  const [identity] = yield sql(
    'SELECT local_id FROM sync_identity WHERE object_id=?',
    [alias ? alias.object_id : id],
  );
  if (!identity) throw new Error('missing_dependencies');
  const dead = yield sql('SELECT * FROM sync_tombstones WHERE object_id=?', [
    alias ? alias.object_id : id,
  ]);
  return dead.length ? null : String(identity.local_id);
}
function* references(
  row: SqlRow,
  uuid: () => string,
): Generator<ReturnType<typeof sql>, Record<string, string | null>, SqlRow[]> {
  const out: Record<string, string | null> = {};
  for (const [column, type, field] of [
    ['category_id', 'category', 'categoryId'],
    ['payment_method_id', 'paymentMethod', 'paymentMethodId'],
    ['card_id', 'card', 'cardId'],
  ] as const)
    out[field] = row[column]
      ? yield* identityFor(type, String(row[column]), uuid)
      : null;
  return out;
}
function structure(type: EntityType, row: SqlRow) {
  const keys =
    type === 'recurring'
      ? [
          'frequency',
          'interval_count',
          'interval_unit',
          'anchor_to_actual',
          'manual_months',
          'start_month',
          'start_date',
        ]
      : [];
  return canonicalStringify(
    Object.fromEntries(keys.map((k) => [k, row[k] ?? null])),
  );
}
export function* ensureSeries(
  type: 'recurring' | 'installmentPurchase',
  row: SqlRow,
  uuid: () => string,
  legacy = false,
): Generator<ReturnType<typeof sql>, SqlRow, SqlRow[]> {
  const [saved] = yield sql(
    'SELECT * FROM sync_series WHERE entity_type=? AND local_id=?',
    [type, row.id],
  );
  const signature = structure(type, row);
  if (!saved) {
    yield sql('INSERT INTO sync_series VALUES(?,?,?,?,?)', [
      type,
      row.id,
      uuid(),
      signature,
      legacy ? 'identity_unresolved' : 'resolved',
    ]);
  } else if (saved.structure_json !== signature) {
    yield sql(
      'UPDATE sync_series SET schedule_epoch=?,structure_json=? WHERE entity_type=? AND local_id=?',
      [uuid(), signature, type, row.id],
    );
  }
  return (yield sql(
    'SELECT * FROM sync_series WHERE entity_type=? AND local_id=?',
    [type, row.id],
  ))[0];
}
function* ensureSlot(
  row: SqlRow,
  uuid: () => string,
): Generator<ReturnType<typeof sql>, SqlRow, SqlRow[]> {
  const [existing] = yield sql('SELECT * FROM sync_slots WHERE local_id=?', [
    row.id,
  ]);
  if (existing) return existing;
  const type =
    row.source_type === 'recurring' ? 'recurring' : 'installmentPurchase';
  const seriesId = yield* identityFor(type, String(row.source_id), uuid);
  const [series] = yield sql(`SELECT * FROM ${tableFor(type)} WHERE id=?`, [
    row.source_id,
  ]);
  if (!series) throw new Error('missing_series');
  const meta = yield* ensureSeries(type, series, uuid);
  if (meta.identity_status !== 'resolved')
    throw new Error('identity_unresolved');
  const original = String(
    row.occurrence_date ?? row.purchase_date ?? row.due_date,
  );
  let key: string,
    slotId: string | null = null;
  if (type === 'installmentPurchase') {
    slotId = derivedId(
      seriesId,
      `slot:${Number(row.installment_number) - Number(series.starting_installment) + 1}`,
    );
    key = `installment:${slotId}`;
  } else if (series.frequency === 'monthly')
    key = `monthly:${original.slice(0, 7)}`;
  else if (series.frequency === 'manual')
    key = `manual:${meta.schedule_epoch}:${original.slice(0, 7)}`;
  else if (series.anchor_to_actual) {
    const predecessors = yield sql(
      "SELECT t.* FROM transactions t WHERE source_type='recurring' AND source_id=? AND id!=? AND status IN ('paid','received') AND settled_date<=? ORDER BY settled_date DESC,id LIMIT 1",
      [row.source_id, row.id, original],
    );
    const predecessor = predecessors[0]
      ? yield* identityFor('transaction', String(predecessors[0].id), uuid)
      : seriesId;
    key = `${meta.schedule_epoch}:after:${predecessor}`;
  } else key = `${meta.schedule_epoch}:${original}`;
  const [same] = yield sql(
    'SELECT * FROM sync_slots WHERE series_id=? AND slot_key=?',
    [seriesId, key],
  );
  const objectId = same ? String(same.object_id) : derivedId(seriesId, key);
  if (same && same.local_id !== row.id) {
    const present = yield sql('SELECT id FROM transactions WHERE id=?', [
      same.local_id,
    ]);
    if (present.length) throw new Error('slot_identity_collision');
    yield sql(
      'UPDATE sync_slots SET local_id=?,original_date=? WHERE object_id=?',
      [row.id, original, same.object_id],
    );
  }
  const [identity] = yield sql(
    "SELECT * FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
    [row.id],
  );
  if (identity && identity.object_id !== objectId)
    throw new Error('identity_review_required');
  if (!identity)
    yield sql("INSERT INTO sync_identity VALUES('transaction',?,?)", [
      row.id,
      objectId,
    ]);
  yield sql('INSERT OR IGNORE INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
    row.id,
    seriesId,
    key,
    slotId,
    objectId,
    original,
    type === 'installmentPurchase'
      ? Number(row.installment_number) - Number(series.starting_installment) + 1
      : null,
  ]);
  if (type === 'recurring' && !same)
    yield sql(
      "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET row_json=excluded.row_json",
      [tableFor(type), series.id, canonicalStringify(series)],
    );
  return (yield sql('SELECT * FROM sync_slots WHERE local_id=?', [row.id]))[0];
}
export function* snapshotFor(
  type: EntityType,
  row: SqlRow,
  uuid: () => string,
): Generator<ReturnType<typeof sql>, Snapshots[EntityType], SqlRow[]> {
  const refs = yield* references(row, uuid);
  switch (type) {
    case 'category':
      return {
        name: String(row.name),
        kind: row.kind,
        color: String(row.color),
      } as Snapshots['category'];
    case 'paymentMethod':
      return { name: String(row.name) };
    case 'card':
      return {
        name: String(row.name),
        dueDay: Number(row.due_day),
        closingDay: row.closing_day as number | null,
      };
    case 'goal':
      return {
        categoryId: refs.categoryId,
        name: row.name,
        itemModel: row.item_model ?? '',
        link: row.link ?? '',
        targetAmountCents: Number(row.target_cents ?? row.target_amount_cents),
        savedAmountCents: Number(row.saved_cents ?? row.saved_amount_cents),
        priority: row.priority,
        dueDate: row.due_date,
        status: row.status,
        notes: row.notes ?? '',
      } as unknown as Snapshots['goal'];
    case 'recurring': {
      const meta = yield* ensureSeries(type, row, uuid);
      const seriesId = yield* identityFor(type, String(row.id), uuid);
      const slots = yield sql(
        'SELECT * FROM sync_slots WHERE series_id=? ORDER BY original_index,slot_key',
        [seriesId],
      );
      return {
        ...refs,
        kind: row.kind,
        active: !!row.active,
        description: row.description,
        startMonth: row.start_month,
        startDate: row.start_date,
        frequency: row.frequency,
        intervalCount: Number(row.interval_count),
        intervalUnit: row.interval_unit,
        anchorToActual: !!row.anchor_to_actual,
        manualMonths: String(row.manual_months ?? '')
          .split(',')
          .filter(Boolean),
        scheduleEpoch: meta.schedule_epoch,
        plannedAmountCents: Number(
          row.planned_cents ?? row.planned_amount_cents,
        ),
        dueDay: Number(row.due_day),
        chargeDay: row.charge_day,
        notes: row.notes ?? '',
        identityStatus: meta.identity_status,
        aliases: slots.map((s) => ({
          slotKey: s.slot_key,
          objectId: s.object_id,
          originalDate: s.original_date,
        })),
      } as unknown as Snapshots['recurring'];
    }
    case 'installmentPurchase': {
      const meta = yield* ensureSeries(type, row, uuid);
      const seriesId = yield* identityFor(type, String(row.id), uuid);
      for (
        let index = 1;
        meta.identity_status === 'resolved' &&
        index <=
          Number(row.total_installments) - Number(row.starting_installment) + 1;
        index++
      ) {
        if (
          (yield sql(
            'SELECT local_id FROM sync_slots WHERE series_id=? AND original_index=?',
            [seriesId, index],
          )).length
        )
          continue;
        const slotId = derivedId(seriesId, `slot:${index}`),
          objectId = derivedId(seriesId, `installment:${slotId}`);
        yield sql('INSERT OR IGNORE INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
          objectId,
          seriesId,
          `installment:${slotId}`,
          slotId,
          objectId,
          null,
          index,
        ]);
      }
      const slots = yield sql(
        'SELECT * FROM sync_slots WHERE series_id=? ORDER BY original_index,slot_key',
        [seriesId],
      );
      return {
        ...refs,
        description: row.description,
        installmentAmountCents: Number(
          row.installment_cents ?? row.installment_amount_cents,
        ),
        totalInstallments: Number(row.total_installments),
        startingInstallment: Number(row.starting_installment),
        purchaseDate: row.purchase_date,
        firstDueDate: row.first_due_date,
        status: row.status,
        notes: row.notes ?? '',
        identityStatus: meta.identity_status,
        slots: slots.map((s) => ({
          slotId: s.slot_id,
          originalIndex: Number(s.original_index),
          objectId: s.object_id,
        })),
      } as unknown as Snapshots['installmentPurchase'];
    }
    case 'transaction': {
      let source: Snapshots['transaction']['source'] = { type: 'manual' };
      let occurrenceDate: string | null =
        (row.occurrence_date as string | null) ?? null;
      if (
        row.source_type === 'recurring' ||
        row.source_type === 'installment'
      ) {
        const slot = yield* ensureSlot(row, uuid);
        source =
          row.source_type === 'recurring'
            ? {
                type: 'recurring',
                seriesId: String(slot.series_id),
                slotKey: String(slot.slot_key),
              }
            : {
                type: 'installment',
                purchaseId: String(slot.series_id),
                slotId: String(slot.slot_id),
              };
        occurrenceDate = String(slot.original_date);
      } else if (row.source_type === 'imported') {
        const [p] = yield sql(
          'SELECT * FROM sync_import_provenance WHERE local_id=?',
          [row.id],
        );
        if (!p) throw new Error('import_provenance_review');
        source = {
          type: 'imported',
          importKey: String(p.import_key),
          importAlgorithmVersion: 1,
        };
      }
      return {
        ...refs,
        kind: row.kind,
        description: row.description,
        plannedAmountCents: Number(
          row.planned_cents ?? row.planned_amount_cents,
        ),
        actualAmountCents: (row.actual_cents ??
          row.actual_amount_cents ??
          null) as number | null,
        purchaseDate: row.purchase_date,
        dueDate: row.due_date,
        settledDate: row.settled_date,
        status: row.status,
        notes: row.notes ?? '',
        source,
        installmentNumber: row.installment_number ?? null,
        installmentTotal: row.installment_total ?? null,
        occurrenceDate,
      } as Snapshots['transaction'];
    }
    case 'recurringPriorityList': {
      const rows = yield sql(
        'SELECT * FROM recurring_transaction_priorities ORDER BY position',
      );
      const entries: Snapshots['recurringPriorityList']['entries'] = [];
      for (const r of rows)
        entries.push({
          seriesId: yield* identityFor(
            'recurring',
            String(r.recurring_id),
            uuid,
          ),
          pinnedFromMonth: String(r.pinned_from_month),
        });
      return { entries };
    }
    case 'monthlyPriorityList': {
      const rows = yield sql(
        'SELECT * FROM transaction_priority_order WHERE month=? ORDER BY position',
        [row.month ?? row.id],
      );
      const transactionIds: string[] = [];
      for (const r of rows) {
        const [tx] = yield sql('SELECT * FROM transactions WHERE id=?', [
          r.transaction_id,
        ]);
        if (tx.source_type === 'recurring' || tx.source_type === 'installment')
          yield* ensureSlot(tx, uuid);
        transactionIds.push(
          yield* identityFor('transaction', String(r.transaction_id), uuid),
        );
      }
      return { month: String(row.month ?? row.id), transactionIds };
    }
  }
}
export function* recordFinancialRevision(
  type: EntityType,
  localId: string,
  revision: RevisionPlaintext,
  uuid: () => string,
  expectedHeads?: string[],
): SqlWorkflow {
  assertFinancialRevision(revision);
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  const objectId = yield* identityFor(
    type,
    localId,
    uuid,
    type.endsWith('PriorityList') ? String(state.vault_id) : undefined,
  );
  const heads = (yield sql(
    'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
    [objectId],
  )).map((r) => String(r.revision_id));
  if (
    expectedHeads &&
    canonicalStringify(expectedHeads) !== canonicalStringify(heads)
  )
    throw new Error('heads_changed');
  if (heads.length > 1 && !expectedHeads) {
    yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
      uuid(),
      objectId,
      'conflict_local_draft',
      canonicalStringify(revision),
    ]);
    return;
  }
  if (
    revision.action === 'put' &&
    (yield sql('SELECT * FROM sync_tombstones WHERE object_id=?', [objectId]))
      .length
  ) {
    yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
      uuid(),
      objectId,
      'deleted_local_draft',
      canonicalStringify(revision),
    ]);
    return;
  }
  const id = uuid(),
    commit = uuid(),
    seq = incrementDecimal64(String(state.local_seq));
  yield sql('INSERT INTO sync_revisions VALUES(?,?,?,?,?,?,?,?)', [
    id,
    objectId,
    commit,
    seq,
    revision.action,
    revision.authoredAt,
    canonicalStringify(heads),
    canonicalStringify(revision),
  ]);
  yield sql('DELETE FROM sync_heads WHERE object_id=?', [objectId]);
  yield sql('INSERT INTO sync_heads VALUES(?,?)', [objectId, id]);
  if (revision.action === 'delete')
    yield sql('INSERT INTO sync_tombstones VALUES(?,?,?)', [
      objectId,
      id,
      revision.deletedAt ?? revision.authoredAt,
    ]);
  yield sql(
    "INSERT INTO sync_outbox(commit_id,local_seq,state,payload_json) VALUES(?,?,'pending',?)",
    [
      commit,
      seq,
      canonicalStringify({
        formatVersion: 1,
        commitId: commit,
        localSeq: seq,
        operations: [
          {
            opId: id,
            objectId,
            parents: heads,
            ...(expectedHeads ? { expectedHeads } : {}),
            revision,
          },
        ],
      }),
    ],
  );
  yield sql('UPDATE sync_local_state SET local_seq=? WHERE id=1', [seq]);
}
/** Flush only on the writer's transaction handle; dirty snapshots themselves are durable if a legacy writer bypasses the wrapper. */
export function* captureFinancial(
  uuid: () => string,
  authoredAt = new Date().toISOString(),
  baseline = false,
): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (state.mode !== 'financial') return;
  let dirty = yield sql('SELECT * FROM sync_dirty');
  const order = Object.keys(financialTableTypes);
  dirty.sort(
    (a, b) =>
      order.indexOf(String(a.table_name)) - order.indexOf(String(b.table_name)),
  );
  // Assign new cached slots before snapshotting aggregates, without enqueuing a cache revision.
  for (const d of dirty.filter((d) => d.table_name === 'transactions')) {
    const r = JSON.parse(String(d.row_json)) as SqlRow;
    if (
      ['recurring', 'installment'].includes(String(r.source_type)) &&
      d.operation !== 'delete'
    ) {
      try {
        yield* ensureSlot(r, uuid);
      } catch (e) {
        if (
          !(e instanceof Error) ||
          ![
            'identity_unresolved',
            'missing_series',
            'identity_review_required',
          ].includes(e.message)
        )
          throw e;
      }
    }
  }
  dirty = yield sql('SELECT * FROM sync_dirty');
  dirty.sort(
    (a, b) =>
      order.indexOf(String(a.table_name)) - order.indexOf(String(b.table_name)),
  );
  for (const d of dirty) {
    const table = String(d.table_name) as keyof typeof financialTableTypes,
      type = financialTableTypes[table];
    const r = JSON.parse(String(d.row_json)) as SqlRow;
    const id = String(d.local_id);
    const [tracked] = yield sql(
      'SELECT * FROM sync_identity WHERE entity_type=? AND local_id=?',
      [type, id],
    );
    const dead = d.operation === 'delete' || r.deleted_at != null;
    if (
      type === 'transaction' &&
      ['recurring', 'installment'].includes(String(r.source_type))
    ) {
      const revisions = tracked
        ? yield sql('SELECT * FROM sync_revisions WHERE object_id=?', [
            tracked.object_id,
          ])
        : [];
      // A reviewed slot is part of the shared series: publish its deletion so
      // another device cannot regenerate the excluded occurrence as active.
      if (
        dead && !revisions.length &&
        !(yield sql('SELECT local_id FROM sync_slots WHERE local_id=?', [id])).length
      ) continue;
      if (
        d.operation === 'insert' &&
        r.status === 'planned' &&
        r.actual_cents == null &&
        r.actual_amount_cents == null &&
        !r.deleted_at
      )
        continue;
    }
    const metadata = {
      domainSchema: 1 as const,
      entityType: type,
      authoredAt,
      provenance: {
        localScopeId: String(state.local_scope_id),
        origin: baseline ? ('migration' as const) : ('local' as const),
        legacyCreatedAt: (r.created_at as string | null) ?? null,
        legacyUpdatedAt: (r.updated_at as string | null) ?? null,
        legacyDeletedAt: (r.deleted_at as string | null) ?? null,
      },
      dependencies: [] as RevisionPlaintext['dependencies'],
      restoredFrom: null,
    };
    let revision: RevisionPlaintext;
    try {
      if (dead && !type.endsWith('PriorityList')) {
        if (
          baseline &&
          r.deleted_at &&
          !/^\d{4}-\d\d-\d\dT/.test(String(r.deleted_at))
        )
          throw new Error('legacy_delete_review');
        revision = {
          ...metadata,
          action: 'delete',
          snapshot: null,
          reason: 'user',
          deletedAt: authoredAt,
          slotKey: null,
          importKey: null,
        } as RevisionPlaintext;
      } else {
        const snapshot = yield* snapshotFor(type, r, uuid);
        if (
          'identityStatus' in snapshot &&
          snapshot.identityStatus === 'identity_unresolved'
        )
          throw new Error('identity_unresolved');
        revision = {
          ...metadata,
          action: 'put',
          snapshot,
        } as RevisionPlaintext;
        const refIds = Object.entries(snapshot)
          .filter(
            ([k, v]) =>
              ['categoryId', 'paymentMethodId', 'cardId'].includes(k) && v,
          )
          .map(([, v]) => String(v));
        if (type === 'transaction') {
          const src = (snapshot as Snapshots['transaction']).source;
          if (src.type === 'recurring') refIds.push(src.seriesId);
          if (src.type === 'installment') refIds.push(src.purchaseId);
        }
        if (type === 'monthlyPriorityList')
          refIds.push(
            ...(snapshot as Snapshots['monthlyPriorityList']).transactionIds,
          );
        if (type === 'recurringPriorityList')
          refIds.push(
            ...(snapshot as Snapshots['recurringPriorityList']).entries.map(
              (e) => e.seriesId,
            ),
          );
        for (const reference of [...new Set(refIds)]) {
          let objectId = reference;
          if (
            type === 'monthlyPriorityList' &&
            !(yield sql(
              'SELECT revision_id FROM sync_heads WHERE object_id=?',
              [objectId],
            )).length
          ) {
            const [slot] = yield sql(
              'SELECT series_id FROM sync_slots WHERE object_id=?',
              [objectId],
            );
            if (slot) objectId = String(slot.series_id);
          }
          if (metadata.dependencies.some((d) => d.objectId === objectId))
            continue;
          const heads = yield sql(
            'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
            [objectId],
          );
          if (heads.length !== 1) throw new Error('dependency_review_required');
          metadata.dependencies.push({
            objectId,
            revisionId: String(heads[0].revision_id),
          });
        }
      }
      yield* recordFinancialRevision(type, id, revision, uuid);
      const [identity] = yield sql(
        'SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?',
        [type, id],
      );
      yield sql(
        "DELETE FROM sync_review WHERE object_id=? AND reason IN ('identity_unresolved','dependency_review_required','import_provenance_review','legacy_delete_review')",
        [identity.object_id],
      );
    } catch (e) {
      if (
        !(e instanceof Error) ||
        ![
          'identity_unresolved',
          'import_provenance_review',
          'legacy_delete_review',
          'dependency_review_required',
        ].includes(e.message)
      )
        throw e;
      const objectId = yield* identityFor(type, id, uuid);
      yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
        uuid(),
        objectId,
        e.message,
        canonicalStringify({ table, localId: id, row: r }),
      ]);
    }
  }
  yield sql('DELETE FROM sync_dirty');
  if (!baseline) {
    const pending = yield sql(
      "SELECT * FROM sync_outbox WHERE state='pending' AND (length(local_seq)>length(?) OR (length(local_seq)=length(?) AND local_seq>?)) ORDER BY length(local_seq),local_seq",
      [state.local_seq, state.local_seq, state.local_seq],
    );
    // Each newly captured revision starts as a one-operation commit. Keep
    // large series within the protocol limit instead of blocking the whole review.
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      if (batch.length < 2) continue;
      const last = batch[batch.length - 1],
        operations = batch.flatMap(
          (item) => JSON.parse(String(item.payload_json)).operations,
        );
      for (const item of batch) {
        yield sql('UPDATE sync_revisions SET commit_id=? WHERE commit_id=?', [
          last.commit_id,
          item.commit_id,
        ]);
        if (item.commit_id !== last.commit_id)
          yield sql('DELETE FROM sync_outbox WHERE commit_id=?', [item.commit_id]);
      }
      yield sql('UPDATE sync_outbox SET payload_json=? WHERE commit_id=?', [
        canonicalStringify({
          formatVersion: 1,
          commitId: last.commit_id,
          localSeq: last.local_seq,
          operations,
        }),
        last.commit_id,
      ]);
    }
  }
}
export function* startFinancialBaseline(
  profile: ProvisionedProfile,
  endpoint: string,
  backupPath: string,
  uuid: () => string,
): SqlWorkflow {
  const [s] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  if (
    s.mode !== 'disabled' ||
    s.binding_id ||
    !backupPath ||
    !profile.checkpoint
  )
    throw new Error('baseline_unavailable');
  const scope = s.local_scope_id ? String(s.local_scope_id) : uuid(),
    binding = uuid(),
    p = profile.pin;
  yield sql('INSERT INTO sync_bindings VALUES(?,?,?,?,?,?,?,?,?,?)', [
    binding,
    scope,
    endpoint,
    p.serverId,
    p.serverEpoch,
    p.vaultId,
    profile.deviceId,
    canonicalStringify(p),
    canonicalStringify(profile.grants),
    canonicalStringify(profile.checkpoint),
  ]);
  yield sql(
    "UPDATE sync_local_state SET mode='financial',local_scope_id=?,binding_id=?,server_id=?,server_epoch=?,vault_id=?,device_id=? WHERE id=1",
    [scope, binding, p.serverId, p.serverEpoch, p.vaultId, profile.deviceId],
  );
  const manifest: Record<string, number> = {};
  for (const [table, type] of Object.entries(financialTableTypes)) {
    const rows = yield sql(`SELECT * FROM ${table}`);
    manifest[table] = rows.length;
    if (type === 'recurringPriorityList' && rows.length)
      yield sql(
        "INSERT INTO sync_dirty VALUES(?,'recurring-priorities','insert',?)",
        [table, canonicalStringify({ id: 'recurring-priorities' })],
      );
    if (type === 'monthlyPriorityList')
      for (const month of [...new Set(rows.map((r) => String(r.month)))])
        yield sql("INSERT INTO sync_dirty VALUES(?,?,'insert',?)", [
          table,
          month,
          canonicalStringify({ month }),
        ]);
    if (type.endsWith('PriorityList')) continue;
    for (const row of rows) {
      if (type === 'recurring' || type === 'installmentPurchase')
        yield* ensureSeries(type, row, uuid, true);
      yield sql("INSERT INTO sync_dirty VALUES(?,?,'insert',?)", [
        table,
        row.id,
        canonicalStringify(row),
      ]);
    }
  }
  yield sql("INSERT INTO sync_bootstrap VALUES(1,'captured',?,?)", [
    canonicalStringify(manifest),
    backupPath,
  ]);
  yield* captureFinancial(uuid, new Date().toISOString(), true);
}
export interface ReviewedSlot {
  localId: string;
  originalDate: string;
  slotKey: string;
  originalIndex: number | null;
  publish: boolean;
}
/** Dates/keys are explicit user assertions. Legacy PKs, FKs, and existing random identities remain intact. */
export function* reviewLegacySeries(
  type: 'recurring' | 'installmentPurchase',
  localId: string,
  slots: ReviewedSlot[],
  uuid: () => string,
): SqlWorkflow {
  const [row] = yield sql(`SELECT * FROM ${tableFor(type)} WHERE id=?`, [
    localId,
  ]);
  if (!row) throw new Error('series_missing');
  const meta = yield* ensureSeries(type, row, uuid, true);
  if (meta.identity_status !== 'identity_unresolved')
    throw new Error('series_already_reviewed');
  const seriesId = yield* identityFor(type, localId, uuid);
  const transactions = yield sql(
    'SELECT * FROM transactions WHERE source_type=? AND source_id=?',
    [type === 'recurring' ? 'recurring' : 'installment', localId],
  );
  if (
    slots.length !== transactions.length ||
    new Set(slots.map((s) => s.localId)).size !== slots.length
  )
    throw new Error('Revise todos os slots desta série.');
  const keys = new Set<string>();
  for (const choice of slots) {
    const tx = transactions.find((t) => t.id === choice.localId);
    if (
      !tx ||
      !isValidDate(choice.originalDate) ||
      !choice.slotKey ||
      keys.has(choice.slotKey)
    )
      throw new Error('Datas e slots exigem revisão explícita sem duplicatas.');
    keys.add(choice.slotKey);
    const objectId = yield* identityFor('transaction', choice.localId, uuid),
      slotId = type === 'installmentPurchase' ? uuid() : null;
    const key =
      type === 'installmentPurchase' ? `installment:${slotId}` : choice.slotKey;
    if (
      type === 'installmentPurchase' &&
      (!Number.isSafeInteger(choice.originalIndex) ||
        Number(choice.originalIndex) < 1)
    )
      throw new Error('Confira a posição original da parcela.');
    yield sql('INSERT INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
      choice.localId,
      seriesId,
      key,
      slotId,
      objectId,
      choice.originalDate,
      choice.originalIndex,
    ]);
    if (choice.publish)
      yield sql(
        "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET operation='update',row_json=excluded.row_json",
        ['transactions', choice.localId, canonicalStringify(tx)],
      );
    yield sql(
      "DELETE FROM sync_review WHERE object_id=? AND reason='identity_unresolved'",
      [objectId],
    );
  }
  yield sql(
    "UPDATE sync_series SET identity_status='resolved' WHERE entity_type=? AND local_id=?",
    [type, localId],
  );
  yield sql(
    "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET operation='update',row_json=excluded.row_json",
    [tableFor(type), localId, canonicalStringify(row)],
  );
  yield sql(
    "DELETE FROM sync_review WHERE object_id=? AND reason='identity_unresolved'",
    [seriesId],
  );
  yield* captureFinancial(uuid);
}

/** Same-device restore: preserve old DAG/outbox, capture only local differences, receive before releasing writes. */
export function* reconnectFinancial(
  profile: ProvisionedProfile,
  endpoint: string,
  backupPath: string,
  uuid: () => string,
): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  const [binding] = yield sql(
    'SELECT * FROM sync_bindings WHERE binding_id=?',
    [state.binding_id],
  );
  if (
    state.mode !== 'disabled' ||
    !binding ||
    state.device_id !== profile.deviceId ||
    binding.pin_json !== canonicalStringify(profile.pin) ||
    binding.endpoint !== endpoint
  )
    throw new Error('restore_binding_mismatch');
  yield sql(
    "INSERT INTO sync_review VALUES(?,NULL,'restore_reconnect_backup',?)",
    [uuid(), canonicalStringify({ backupPath })],
  );
  yield sql("UPDATE sync_local_state SET mode='financial' WHERE id=1");
  for (const [table, type] of Object.entries(financialTableTypes)) {
    if (type.endsWith('PriorityList')) continue;
    const rows = yield sql(`SELECT * FROM ${table}`);
    for (const row of rows) {
      const [identity] = yield sql(
        'SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?',
        [type, row.id],
      );
      const heads = identity
        ? yield sql(
            'SELECT r.payload_json FROM sync_heads h JOIN sync_revisions r USING(revision_id) WHERE h.object_id=?',
            [identity.object_id],
          )
        : [];
      let changed = !identity || heads.length !== 1;
      if (!changed) {
        const revision = JSON.parse(
          String(heads[0].payload_json),
        ) as RevisionPlaintext;
        if (row.deleted_at) changed = revision.action !== 'delete';
        else if (revision.action !== 'put') changed = true;
        else
          try {
            changed =
              canonicalStringify(yield* snapshotFor(type, row, uuid)) !==
              canonicalStringify(revision.snapshot);
          } catch {
            changed = true;
          }
      }
      if (changed)
        yield sql(
          "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET operation='update',row_json=excluded.row_json",
          [table, row.id, canonicalStringify(row)],
        );
    }
  }
  for (const type of [
    'recurringPriorityList',
    'monthlyPriorityList',
  ] as const) {
    const table = tableFor(type);
    const identities = yield sql(
      'SELECT local_id FROM sync_identity WHERE entity_type=?',
      [type],
    );
    const actual = yield sql(
      type === 'monthlyPriorityList'
        ? 'SELECT DISTINCT month AS local_id FROM transaction_priority_order'
        : 'SELECT recurring_id AS local_id FROM recurring_transaction_priorities',
    );
    const ids =
      type === 'recurringPriorityList'
        ? identities.length || actual.length
          ? ['recurring-priorities']
          : []
        : [
            ...new Set(
              [...identities, ...actual].map((i) => String(i.local_id)),
            ),
          ];
    for (const id of ids) {
      const row: SqlRow =
        type === 'monthlyPriorityList' ? { month: id } : { id };
      const snapshot = yield* snapshotFor(type, row, uuid);
      const heads = yield sql(
        'SELECT r.payload_json FROM sync_identity i JOIN sync_heads h USING(object_id) JOIN sync_revisions r USING(revision_id) WHERE i.entity_type=? AND i.local_id=?',
        [type, id],
      );
      if (
        heads.length !== 1 ||
        canonicalStringify(
          (JSON.parse(String(heads[0].payload_json)) as RevisionPlaintext)
            .snapshot,
        ) !== canonicalStringify(snapshot)
      )
        yield sql(
          "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET row_json=excluded.row_json",
          [table, id, canonicalStringify(row)],
        );
    }
  }
  for (const identity of yield sql('SELECT * FROM sync_identity')) {
    if (String(identity.entity_type) === 'manualTransaction') continue;
    const type = String(identity.entity_type) as EntityType;
    if (type.endsWith('PriorityList')) continue;
    const table = tableFor(type);
    if (
      !(yield sql(`SELECT id FROM ${table} WHERE id=?`, [identity.local_id]))
        .length &&
      !(yield sql('SELECT revision_id FROM sync_tombstones WHERE object_id=?', [
        identity.object_id,
      ])).length
    )
      yield sql('INSERT INTO sync_review VALUES(?,?,?,?)', [
        uuid(),
        identity.object_id,
        'restored_missing_record',
        canonicalStringify({ table, localId: identity.local_id }),
      ]);
  }
  yield* captureFinancial(uuid);
  yield sql(
    "UPDATE sync_bootstrap SET state='joining_review',backup_path=? WHERE id=1",
    [backupPath],
  );
  yield sql('UPDATE sync_control SET paused=0 WHERE id=1');
}
