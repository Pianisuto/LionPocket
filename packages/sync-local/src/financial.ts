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
import {
  incrementDecimal64,
  type SqlRow,
  type SqlWorkflow,
  type SqlRequest,
} from './manual';
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
      'resolved',
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
/** Historical installment membership is encoded in existing UUID fields; no wire/schema extension. */
export const isLegacyInstallmentSlot = (slotId: string, objectId: string) =>
  slotId === derivedId(objectId, 'legacy-installment-slot:v1');
/** Synthetic legacy import keys identify the adopted row, not an unverifiable old file. */
function* legacyImport(
  row: SqlRow,
): Generator<ReturnType<typeof sql>, SqlRow, SqlRow[]> {
  const [known] = yield sql(
    'SELECT * FROM sync_import_provenance WHERE local_id=?',
    [row.id],
  );
  if (known) return known;
  const [state] = yield sql('SELECT vault_id FROM sync_local_state WHERE id=1');
  const key = importDigest({
    context: 'LionPocket/legacy-import-row/v1',
    vaultId: state.vault_id,
    id: row.id,
  });
  yield sql('INSERT INTO sync_import_provenance VALUES(?,?,?)', [
    row.id,
    key,
    row.source_id ?? null,
  ]);
  return { import_key: key };
}
/** Historical slots name existing rows. Their present dates/numbers are not claims about history. */
function* adoptSeriesSlots(
  type: 'recurring' | 'installmentPurchase',
  series: SqlRow,
  uuid: () => string,
): SqlWorkflow {
  const seriesId = yield* identityFor(type, String(series.id), uuid);
  const rows = yield sql(
    'SELECT * FROM transactions WHERE source_type=? AND source_id=? ORDER BY id',
    [type === 'recurring' ? 'recurring' : 'installment', series.id],
  );
  for (const [index, row] of rows.entries()) {
    if (
      (yield sql('SELECT local_id FROM sync_slots WHERE local_id=?', [row.id]))
        .length
    )
      continue;
    const [state] = yield sql(
      'SELECT vault_id FROM sync_local_state WHERE id=1',
    );
    const objectId = yield* identityFor(
      'transaction',
      String(row.id),
      uuid,
      String(state.vault_id),
    );
    const slotId =
      type === 'installmentPurchase'
        ? derivedId(objectId, 'legacy-installment-slot:v1')
        : null;
    const currentIndex =
      Number(row.installment_number) - Number(series.starting_installment) + 1;
    yield sql('INSERT INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
      row.id,
      seriesId,
      slotId ? `installment:${slotId}` : `legacy:${objectId}`,
      slotId,
      objectId,
      row.occurrence_date ?? row.purchase_date ?? row.due_date,
      slotId
        ? currentIndex >= 1
          ? currentIndex
          : Number(series.total_installments) + index + 1
        : null,
    ]);
  }
}
/** Resume sidecars captured by older clients without asking users to repair protocol identity. */
function* adoptUnresolvedSeries(
  uuid: () => string,
): Generator<SqlRequest, boolean, SqlRow[]> {
  const unresolved = yield sql(
    "SELECT * FROM sync_series WHERE identity_status='identity_unresolved'",
  );
  let adopted = false;
  for (const meta of unresolved) {
    const type = String(meta.entity_type) as
      'recurring' | 'installmentPurchase';
    const [row] = yield sql(`SELECT * FROM ${tableFor(type)} WHERE id=?`, [
      meta.local_id,
    ]);
    if (!row) continue;
    adopted = true;
    yield* adoptSeriesSlots(type, row, uuid);
    yield sql(
      "UPDATE sync_series SET identity_status='resolved' WHERE entity_type=? AND local_id=?",
      [type, row.id],
    );
    for (const tx of [
      row,
      ...(yield sql(
        'SELECT * FROM transactions WHERE source_type=? AND source_id=?',
        [type === 'recurring' ? 'recurring' : 'installment', row.id],
      )),
    ]) {
      const table = tx === row ? tableFor(type) : 'transactions';
      yield sql(
        "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET row_json=excluded.row_json",
        [table, tx.id, canonicalStringify(tx)],
      );
    }
  }
  const reviews = yield sql(
    "SELECT * FROM sync_review WHERE reason IN ('identity_unresolved','import_provenance_review','legacy_delete_review','dependency_review_required')",
  );
  for (const review of reviews) {
    const data = JSON.parse(String(review.payload_json)) as {
      table: string;
      localId: string;
    };
    if (!(data.table in financialTableTypes)) continue;
    const type =
      financialTableTypes[data.table as keyof typeof financialTableTypes];
    const [row] =
      type === 'monthlyPriorityList'
        ? [{ month: data.localId } as SqlRow]
        : type === 'recurringPriorityList'
          ? [{ id: 'recurring-priorities' } as SqlRow]
          : yield sql(`SELECT * FROM ${data.table} WHERE id=?`, [data.localId]);
    if (row) {
      // Unpublished rows left by the old bootstrap are adoption work even when
      // the only missing piece was dependency creation order. Existing user
      // revisions keep their normal atomic capture boundary.
      const heads = yield sql(
        'SELECT h.revision_id FROM sync_heads h JOIN sync_identity i USING(object_id) WHERE i.entity_type=? AND i.local_id=?',
        [type, data.localId],
      );
      if (review.reason !== 'dependency_review_required' || !heads.length)
        adopted = true;
    }
    if (row)
      yield sql(
        "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET row_json=excluded.row_json",
        [data.table, data.localId, canonicalStringify(row)],
      );
    yield sql('DELETE FROM sync_review WHERE review_id=?', [review.review_id]);
  }
  return adopted;
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
    // Several forecasts may follow the same settled legacy predecessor. Their
    // intended dates distinguish them; an existing slot remains stable on edit.
    key = `${meta.schedule_epoch}:after:${predecessor}:${original}`;
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
  baseline = false,
): Generator<ReturnType<typeof sql>, Snapshots[EntityType], SqlRow[]> {
  const refs = yield* references(row, uuid);
  if (['category', 'paymentMethod', 'card'].includes(type)) {
    const [audit] = yield sql(
      "SELECT payload_json FROM sync_review WHERE reason='catalog_projection_audit' AND object_id=(SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?)",
      [type, row.id],
    );
    if (audit) {
      const value = JSON.parse(String(audit.payload_json));
      if (row.name === value.displayName)
        row = { ...row, name: value.originalName };
    }
  }
  switch (type) {
    case 'monthlyPlanning':
      return { month: String(row.month), safetyMarginCents: Number(row.safety_margin_cents) };
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
      const existingSlots = yield sql(
        'SELECT slot_id,object_id FROM sync_slots WHERE series_id=?',
        [seriesId],
      );
      const adopted = existingSlots.some((s) =>
        isLegacyInstallmentSlot(String(s.slot_id), String(s.object_id)),
      );
      for (
        let index = 1;
        !baseline &&
        !adopted &&
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
        if (
          row.source_type === 'recurring' &&
          !String(slot.slot_key).startsWith('legacy:')
        )
          occurrenceDate = String(slot.original_date);
      } else if (row.source_type === 'imported') {
        const [p] = yield sql(
          'SELECT * FROM sync_import_provenance WHERE local_id=?',
          [row.id],
        );
        const provenance = p ?? (yield* legacyImport(row));
        source = {
          type: 'imported',
          importKey: String(provenance.import_key),
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
/** Adoption copies are equivalent only when their complete financial value agrees.
 * User deletions and edits never participate in historical-delete equivalence.
 */
export function* equivalentMigrationHeads(
  objectId: string,
): Generator<ReturnType<typeof sql>, boolean, SqlRow[]> {
  const rows = yield sql(
    'SELECT r.* FROM sync_heads h JOIN sync_revisions r USING(revision_id) WHERE h.object_id=?',
    [objectId],
  );
  if (rows.length < 2) return false;
  const revisions = rows.map(
    (r) => JSON.parse(String(r.payload_json)) as RevisionPlaintext,
  );
  const first = revisions[0];
  const sameMigration = (r: RevisionPlaintext) =>
    r.provenance.origin === 'migration' &&
    r.restoredFrom === null &&
    r.provenance.legacyDeletedAt === first.provenance.legacyDeletedAt;
  if (first.action === 'put')
    return revisions.every(
      (r) =>
        sameMigration(r) &&
        r.action === 'put' &&
        canonicalStringify(r.snapshot) === canonicalStringify(first.snapshot),
    );
  if (first.provenance.legacyDeletedAt === null) return false;
  if (
    !revisions.every(
      (r) =>
        sameMigration(r) &&
        r.action === 'delete' &&
        r.reason === 'legacy_unknown' &&
        r.slotKey === first.slotKey &&
        r.importKey === first.importKey,
    )
  )
    return false;
  const history = yield sql(
    'SELECT * FROM sync_revisions WHERE object_id=? AND revision_id NOT IN (SELECT revision_id FROM sync_rejected)',
    [objectId],
  );
  const byId = new Map(history.map((r) => [String(r.revision_id), r]));
  const visited = new Set<string>();
  let snapshot: string | undefined;
  let hasValue = false;
  const pending = rows.map((r) => String(r.revision_id));
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = byId.get(id);
    if (!row) return false;
    const r = JSON.parse(String(row.payload_json)) as RevisionPlaintext;
    if (!sameMigration(r)) return false;
    if (r.action === 'put') {
      const value = canonicalStringify(r.snapshot);
      if (hasValue && value !== snapshot) return false;
      snapshot = value;
      hasValue = true;
    } else if (
      r.reason !== 'legacy_unknown' ||
      r.slotKey !== first.slotKey ||
      r.importKey !== first.importKey
    )
      return false;
    pending.push(...(JSON.parse(String(row.parents_json)) as string[]));
  }
  // A tombstone with no archived value cannot prove that both copies deleted
  // the same data. authoredAt/deletedAt describe adoption time, not that value.
  return hasValue;
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
    type.endsWith('PriorityList') || type === 'monthlyPlanning' ? String(state.vault_id) : undefined,
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
  if (
    heads.length > 1 &&
    !expectedHeads &&
    !(yield* equivalentMigrationHeads(objectId))
  ) {
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
  if (!baseline && (yield* adoptUnresolvedSeries(uuid))) {
    yield* captureAdoptedBaseline(uuid, authoredAt);
    return;
  }
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
      if (!baseline && dead && !revisions.length) continue;
      if (
        !baseline &&
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
        legacyDeletedAt:
          (r._legacy_deleted_at as string | null) ??
          (r.deleted_at as string | null) ??
          null,
      },
      dependencies: [] as RevisionPlaintext['dependencies'],
      restoredFrom: null,
    };
    let revision: RevisionPlaintext;
    try {
      if (dead && !type.endsWith('PriorityList')) {
        revision = {
          ...metadata,
          action: 'delete',
          snapshot: null,
          reason: baseline ? 'legacy_unknown' : 'user',
          deletedAt: authoredAt,
          slotKey:
            type === 'transaction'
              ? ((yield sql(
                  'SELECT slot_key FROM sync_slots WHERE local_id=?',
                  [id],
                ))[0]?.slot_key ?? null)
              : null,
          importKey: null,
        } as RevisionPlaintext;
      } else {
        const snapshot = yield* snapshotFor(type, r, uuid, baseline);
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
          if (
            heads.length !== 1 &&
            !(yield* equivalentMigrationHeads(objectId))
          )
            throw new Error('dependency_review_required');
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
        !['identity_unresolved', 'dependency_review_required'].includes(
          e.message,
        )
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
  const pending = yield sql(
    "SELECT * FROM sync_outbox WHERE state='pending' AND (length(local_seq)>length(?) OR (length(local_seq)=length(?) AND local_seq>?)) ORDER BY length(local_seq),local_seq",
    [state.local_seq, state.local_seq, state.local_seq],
  );
  if (pending.length > 100 && !baseline) {
    // User mutations retain their atomic boundary. Only adoption may span multiple commits.
    for (const item of pending)
      yield sql(
        "UPDATE sync_outbox SET state='blocked',last_error='batch_too_large' WHERE commit_id=?",
        [item.commit_id],
      );
  } else {
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      if (batch.length < 2) continue;
      const last = batch[batch.length - 1];
      const operations = batch.flatMap(
        (item) => JSON.parse(String(item.payload_json)).operations,
      );
      for (const item of batch) {
        yield sql('UPDATE sync_revisions SET commit_id=? WHERE commit_id=?', [
          last.commit_id,
          item.commit_id,
        ]);
        if (item.commit_id !== last.commit_id)
          yield sql('DELETE FROM sync_outbox WHERE commit_id=?', [
            item.commit_id,
          ]);
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
      if (type === 'monthlyPlanning') {
        // A fresh baseline after detach uses the new vault namespace for the
        // same logical month. Old transport history has already been archived.
        const expected = derivedId(p.vaultId, `${type}:${row.id}`);
        const [known] = yield sql('SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?', [type, row.id]);
        if (known && known.object_id !== expected) {
          if ((yield sql('SELECT revision_id FROM sync_revisions WHERE object_id=? LIMIT 1', [known.object_id])).length)
            throw new Error('baseline_unavailable');
          yield sql('UPDATE sync_identity SET object_id=? WHERE entity_type=? AND local_id=?', [expected, type, row.id]);
        }
      }
      if (['category', 'paymentMethod', 'card'].includes(type)) {
        const value = yield* snapshotFor(type, row, uuid);
        yield* identityFor(type, String(row.id), () =>
          derivedId(
            p.vaultId,
            `catalog:v1:${type}:${canonicalStringify(value)}`,
          ),
        );
      } else yield* identityFor(type, String(row.id), uuid, p.vaultId);
      if (type === 'recurring' || type === 'installmentPurchase') {
        const seriesId = yield* identityFor(type, String(row.id), uuid);
        // The protocol accepts v4-formatted epoch tokens. Adoption hashes existing identity and current structure;
        // subsequent schedule changes still get a fresh CSPRNG epoch in ensureSeries.
        const epoch = derivedId(
          seriesId,
          `legacy-schedule:v1:${structure(type, row)}`,
        );
        yield* ensureSeries(
          type,
          row,
          () => `${epoch.slice(0, 14)}4${epoch.slice(15)}`,
        );
        yield* adoptSeriesSlots(type, row, uuid);
      }
      if (type === 'transaction' && row.source_type === 'imported')
        yield* legacyImport(row);
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
  yield* captureAdoptedBaseline(uuid, new Date().toISOString());
}
/** Archive the current deleted rows first; tombstones alone cannot preserve their financial history. */
function* captureAdoptedBaseline(
  uuid: () => string,
  authoredAt: string,
): SqlWorkflow {
  const deleted: SqlRow[] = [];
  for (const d of yield sql(
    "SELECT * FROM sync_dirty WHERE json_extract(row_json,'$.deleted_at') IS NOT NULL",
  )) {
    const tombstone = yield sql(
      'SELECT t.object_id FROM sync_tombstones t JOIN sync_identity i USING(object_id) WHERE i.entity_type=? AND i.local_id=?',
      [
        financialTableTypes[
          String(d.table_name) as keyof typeof financialTableTypes
        ],
        d.local_id,
      ],
    );
    if (tombstone.length) {
      yield sql('DELETE FROM sync_dirty WHERE table_name=? AND local_id=?', [
        d.table_name,
        d.local_id,
      ]);
      continue;
    }
    deleted.push(d);
    const row = JSON.parse(String(d.row_json));
    row._legacy_deleted_at = row.deleted_at;
    row.deleted_at = null;
    yield sql(
      "UPDATE sync_dirty SET operation='insert',row_json=? WHERE table_name=? AND local_id=?",
      [canonicalStringify(row), d.table_name, d.local_id],
    );
  }
  yield* captureFinancial(uuid, authoredAt, true);
  for (const d of deleted)
    yield sql('INSERT INTO sync_dirty VALUES(?,?,?,?)', [
      d.table_name,
      d.local_id,
      d.operation,
      d.row_json,
    ]);
  yield* captureFinancial(uuid, authoredAt, true);
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
    "UPDATE sync_bootstrap SET state='captured',backup_path=? WHERE id=1",
    [backupPath],
  );
  yield sql('UPDATE sync_control SET paused=0 WHERE id=1');
}
