import { recurringOccurrence } from '@lionpocket/core';
import { addMonths } from '@lionpocket/core';
import {
  assertFinancialRevision,
  canonicalStringify,
  type EntityType,
  type RevisionPlaintext,
  type Snapshots,
} from '@lionpocket/sync-protocol';
import {
  recordFinancialRevision,
  localReference,
  isLegacyInstallmentSlot,
} from './financial';
import { financialTableTypes } from './schema';
import type { SqlRow, SqlWorkflow } from './manual';
const sql = (sql: string, params?: (string | number | null)[]) => ({
  sql,
  params,
});
const tableFor = (type: EntityType) =>
  Object.entries(financialTableTypes).find(
    ([, t]) => t === type,
  )?.[0] as string;
/** A projection transaction sets applying=1. Writers and queries cannot echo incoming commits. */
export function* projectFinancial(
  localId: string,
  revision: RevisionPlaintext,
  dialect: 'desktop' | 'android',
): SqlWorkflow {
  assertFinancialRevision(revision);
  const type = revision.entityType,
    table = tableFor(type);
  if (revision.action === 'delete') {
    if (['category', 'paymentMethod', 'card'].includes(type)) {
      const column =
        type === 'category'
          ? 'category_id'
          : type === 'card'
            ? 'card_id'
            : 'payment_method_id';
      for (const t of [
        'transactions',
        'recurring_expenses',
        'installment_purchases',
        ...(type === 'category' ? ['goals'] : []),
      ])
        yield sql(`UPDATE ${t} SET ${column}=NULL WHERE ${column}=?`, [
          localId,
        ]);
      yield sql(`DELETE FROM ${table} WHERE id=?`, [localId]);
    } else if (type === 'monthlyPriorityList')
      yield sql('DELETE FROM transaction_priority_order WHERE month=?', [
        localId,
      ]);
    else if (type === 'recurringPriorityList')
      yield sql('DELETE FROM recurring_transaction_priorities');
    else {
      yield sql(`UPDATE ${table} SET deleted_at=?,updated_at=? WHERE id=?`, [
        revision.provenance.legacyDeletedAt ?? revision.authoredAt,
        revision.provenance.legacyUpdatedAt ?? revision.authoredAt,
        localId,
      ]);
      if (
        revision.reason !== 'legacy_unknown' &&
        (type === 'recurring' || type === 'installmentPurchase')
      )
        yield sql(
          'UPDATE transactions SET deleted_at=?,updated_at=? WHERE source_type=? AND source_id=?',
          [
            revision.authoredAt,
            revision.authoredAt,
            type === 'recurring' ? 'recurring' : 'installment',
            localId,
          ],
        );
    }
    return;
  }
  const s = revision.snapshot as unknown as Record<string, unknown>;
  const refs: Record<string, string | null> = {};
  for (const [field, column] of [
    ['categoryId', 'category_id'],
    ['paymentMethodId', 'payment_method_id'],
    ['cardId', 'card_id'],
  ])
    if (field in s)
      refs[column] = yield* localReference(s[field] as string | null);
  const row: SqlRow = { id: localId, ...refs };
  const money = (desktop: string, android: string) =>
    dialect === 'desktop' ? desktop : android;
  const map = (mapping: Record<string, string>) => {
    for (const [field, column] of Object.entries(mapping))
      row[column] = s[field] as string | number | null;
  };
  switch (type) {
    case 'category':
      map({ name: 'name', kind: 'kind', color: 'color' });
      break;
    case 'paymentMethod':
      map({ name: 'name' });
      break;
    case 'card':
      map({ name: 'name', dueDay: 'due_day', closingDay: 'closing_day' });
      break;
    case 'goal':
      map({
        name: 'name',
        itemModel: 'item_model',
        link: 'link',
        targetAmountCents: money('target_cents', 'target_amount_cents'),
        savedAmountCents: money('saved_cents', 'saved_amount_cents'),
        priority: 'priority',
        dueDate: 'due_date',
        status: 'status',
        notes: 'notes',
      });
      break;
    case 'recurring': {
      map({
        kind: 'kind',
        description: 'description',
        startMonth: 'start_month',
        startDate: 'start_date',
        frequency: 'frequency',
        intervalCount: 'interval_count',
        intervalUnit: 'interval_unit',
        plannedAmountCents: money('planned_cents', 'planned_amount_cents'),
        dueDay: 'due_day',
        chargeDay: 'charge_day',
        notes: 'notes',
      });
      row.active = s.active ? 1 : 0;
      row.anchor_to_actual = s.anchorToActual ? 1 : 0;
      row.manual_months = (s.manualMonths as string[]).join(',');
      const structure = canonicalStringify(
        Object.fromEntries(
          [
            'frequency',
            'interval_count',
            'interval_unit',
            'anchor_to_actual',
            'manual_months',
            'start_month',
            'start_date',
          ].map((k) => [k, row[k] ?? null]),
        ),
      );
      yield sql(
        'INSERT INTO sync_series VALUES(?,?,?,?,?) ON CONFLICT(entity_type,local_id) DO UPDATE SET schedule_epoch=excluded.schedule_epoch,structure_json=excluded.structure_json,identity_status=excluded.identity_status',
        [
          type,
          localId,
          String(s.scheduleEpoch),
          structure,
          String(s.identityStatus),
        ],
      );
      const [identity] = yield sql(
        'SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?',
        [type, localId],
      );
      for (const a of s.aliases as Snapshots['recurring']['aliases']) {
        const [existing] = yield sql(
          'SELECT * FROM sync_slots WHERE object_id=?',
          [a.objectId],
        );
        const [txIdentity] = yield sql(
          'SELECT local_id FROM sync_identity WHERE object_id=?',
          [a.objectId],
        );
        if (!existing)
          yield sql('INSERT INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
            txIdentity?.local_id ?? a.objectId,
            identity.object_id,
            a.slotKey,
            null,
            a.objectId,
            a.originalDate,
            null,
          ]);
        else if (
          existing.series_id !== identity.object_id ||
          existing.slot_key !== a.slotKey
        )
          throw new Error('slot_identity_collision');
      }
      break;
    }
    case 'installmentPurchase': {
      map({
        description: 'description',
        installmentAmountCents: money(
          'installment_cents',
          'installment_amount_cents',
        ),
        totalInstallments: 'total_installments',
        startingInstallment: 'starting_installment',
        purchaseDate: 'purchase_date',
        firstDueDate: 'first_due_date',
        status: 'status',
        notes: 'notes',
      });
      break;
    }
    case 'transaction': {
      map({
        kind: 'kind',
        description: 'description',
        plannedAmountCents: money('planned_cents', 'planned_amount_cents'),
        actualAmountCents: money('actual_cents', 'actual_amount_cents'),
        purchaseDate: 'purchase_date',
        dueDate: 'due_date',
        settledDate: 'settled_date',
        status: 'status',
        notes: 'notes',
        installmentNumber: 'installment_number',
        installmentTotal: 'installment_total',
      });
      if (dialect === 'android')
        row.occurrence_date = s.occurrenceDate as string | null;
      const src = s.source as Snapshots['transaction']['source'];
      row.source_type = src.type;
      row.source_id = null;
      if (src.type === 'recurring')
        row.source_id = yield* localReference(src.seriesId);
      if (src.type === 'installment')
        row.source_id = yield* localReference(src.purchaseId);
      if (src.type === 'recurring' || src.type === 'installment') {
        const seriesId =
            src.type === 'recurring' ? src.seriesId : src.purchaseId,
          slotKey =
            src.type === 'recurring'
              ? src.slotKey
              : `installment:${src.slotId}`;
        const [identity] = yield sql(
          "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
          [localId],
        );
        const [known] = yield sql(
          'SELECT * FROM sync_slots WHERE object_id=?',
          [identity?.object_id ?? localId],
        );
        if (
          known &&
          (known.series_id !== seriesId || known.slot_key !== slotKey)
        )
          throw new Error('slot_identity_collision');
        if (!known && identity) {
          let originalIndex: number | null = null;
          if (src.type === 'installment') {
            const [purchase] = yield sql(
              'SELECT starting_installment FROM installment_purchases WHERE id=?',
              [row.source_id],
            );
            originalIndex =
              Number(s.installmentNumber) -
              Number(purchase.starting_installment) +
              1;
          }
          yield sql('INSERT INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
            localId,
            seriesId,
            slotKey,
            src.type === 'installment' ? src.slotId : null,
            identity.object_id,
            String(s.occurrenceDate ?? s.dueDate),
            originalIndex,
          ]);
        }
      }
      if (src.type === 'imported') {
        row.source_id = `lp1:${src.importKey}`;
        yield sql(
          'INSERT INTO sync_import_provenance VALUES(?,?,NULL) ON CONFLICT(local_id) DO UPDATE SET import_key=excluded.import_key',
          [localId, src.importKey],
        );
      }
      break;
    }
    case 'recurringPriorityList': {
      yield sql('DELETE FROM recurring_transaction_priorities');
      for (const [position, e] of (
        s.entries as Snapshots['recurringPriorityList']['entries']
      ).entries()) {
        const id = yield* localReference(e.seriesId);
        if (id)
          yield sql(
            'INSERT INTO recurring_transaction_priorities VALUES(?,?,?,?,?)',
            [
              id,
              position,
              e.pinnedFromMonth,
              revision.authoredAt,
              revision.authoredAt,
            ],
          );
      }
      return;
    }
    case 'monthlyPriorityList': {
      yield sql('DELETE FROM transaction_priority_order WHERE month=?', [
        String(s.month),
      ]);
      for (const [position, id] of (s.transactionIds as string[]).entries()) {
        const local = yield* priorityReference(id, dialect);
        if (local)
          yield sql(
            'INSERT INTO transaction_priority_order VALUES(?,?,?,?,?)',
            [
              String(s.month),
              local,
              position,
              revision.authoredAt,
              revision.authoredAt,
            ],
          );
      }
      return;
    }
  }
  if (
    dialect === 'desktop' ||
    !['category', 'paymentMethod', 'card'].includes(type)
  ) {
    row.created_at = revision.provenance.legacyCreatedAt ?? revision.authoredAt;
    row.updated_at = revision.provenance.legacyUpdatedAt ?? revision.authoredAt;
  }
  if (!['category', 'paymentMethod', 'card'].includes(type))
    row.deleted_at =
      revision.provenance.origin === 'migration'
        ? revision.provenance.legacyDeletedAt
        : null;
  if (['category', 'paymentMethod', 'card'].includes(type)) {
    const [collision] = yield sql(
      `SELECT id FROM ${table} WHERE name=?${type === 'category' ? ' AND kind=?' : ''} AND id!=?`,
      type === 'category' ? [row.name, row.kind, localId] : [row.name, localId],
    );
    if (collision) {
      const [identity] = yield sql(
        'SELECT object_id FROM sync_identity WHERE entity_type=? AND local_id=?',
        [type, localId],
      );
      row.name = `${s.name} (outro cadastro)`;
      let index = 2;
      while (
        (yield sql(
          `SELECT id FROM ${table} WHERE name=?${type === 'category' ? ' AND kind=?' : ''} AND id!=?`,
          type === 'category'
            ? [row.name, row.kind, localId]
            : [row.name, localId],
        )).length
      )
        row.name = `${s.name} (outro cadastro ${index++})`;
      yield sql(
        'INSERT INTO sync_review VALUES(?,?,?,?) ON CONFLICT(review_id) DO UPDATE SET payload_json=excluded.payload_json',
        [
          String(identity.object_id),
          identity.object_id,
          'catalog_projection_audit',
          canonicalStringify({ originalName: s.name, displayName: row.name }),
        ],
      );
    }
  }
  const keys = Object.keys(row);
  yield sql(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys
      .filter((k) => k !== 'id' && k !== 'created_at')
      .map((k) => `${k}=excluded.${k}`)
      .join(',')}`,
    Object.values(row),
  );
  if (type === 'installmentPurchase') {
    const [identity] = yield sql(
      "SELECT object_id FROM sync_identity WHERE entity_type='installmentPurchase' AND local_id=?",
      [localId],
    );
    yield sql(
      "INSERT INTO sync_series VALUES('installmentPurchase',?,?,?,?) ON CONFLICT(entity_type,local_id) DO UPDATE SET identity_status=excluded.identity_status",
      [localId, String(identity.object_id), '{}', String(s.identityStatus)],
    );
    const slots = s.slots as Snapshots['installmentPurchase']['slots'];
    for (const slot of slots) {
      const [known] = yield sql('SELECT * FROM sync_slots WHERE object_id=?', [
        slot.objectId,
      ]);
      const [txIdentity] = yield sql(
        'SELECT local_id FROM sync_identity WHERE object_id=?',
        [slot.objectId],
      );
      const txId = known
        ? String(known.local_id)
        : String(txIdentity?.local_id ?? slot.objectId);
      if (!known)
        yield sql('INSERT INTO sync_slots VALUES(?,?,?,?,?,?,?)', [
          txId,
          identity.object_id,
          `installment:${slot.slotId}`,
          slot.slotId,
          slot.objectId,
          row.first_due_date,
          slot.originalIndex,
        ]);
      // Migration publishes every existing transaction separately. Never recreate history from today's schedule.
      if (
        revision.provenance.origin === 'migration' ||
        isLegacyInstallmentSlot(slot.slotId, slot.objectId) ||
        (yield sql('SELECT object_id FROM sync_tombstones WHERE object_id=?', [
          slot.objectId,
        ])).length
      )
        continue;
      const number = Number(row.starting_installment) + slot.originalIndex - 1;
      if (number > Number(row.total_installments)) continue;
      const tx: RevisionPlaintext = {
        ...revision,
        entityType: 'transaction',
        snapshot: {
          kind: 'expense',
          description: String(row.description),
          categoryId: s.categoryId as string | null,
          paymentMethodId: s.paymentMethodId as string | null,
          cardId: s.cardId as string | null,
          plannedAmountCents: Number(s.installmentAmountCents),
          actualAmountCents: null,
          purchaseDate: s.purchaseDate as string | null,
          dueDate: addMonths(String(s.firstDueDate), number - 1),
          settledDate: null,
          status: 'planned',
          notes: String(s.notes),
          source: {
            type: 'installment',
            purchaseId: String(identity.object_id),
            slotId: slot.slotId,
          },
          installmentNumber: number,
          installmentTotal: Number(s.totalInstallments),
          occurrenceDate: null,
        },
      };
      const [current] = yield sql('SELECT id FROM transactions WHERE id=?', [
        txId,
      ]);
      if (!current) yield* projectFinancial(txId, tx, dialect);
    }
  }
}
export function* resolveFinancial(
  objectId: string,
  expectedHeads: string[],
  choice: RevisionPlaintext,
  dialect: 'desktop' | 'android',
  uuid: () => string,
  recover = false,
): SqlWorkflow {
  const heads = (yield sql(
    'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
    [objectId],
  )).map((r) => String(r.revision_id));
  if (canonicalStringify(heads) !== canonicalStringify(expectedHeads))
    throw new Error('heads_changed');
  const deleted =
    (yield sql('SELECT * FROM sync_tombstones WHERE object_id=?', [objectId]))
      .length > 0;
  if (choice.action === 'put' && deleted && !recover)
    throw new Error('deleted_object_requires_recovery');
  const [identity] = yield sql(
    'SELECT * FROM sync_identity WHERE object_id=?',
    [objectId],
  );
  const localId = recover ? uuid() : String(identity.local_id);
  if (recover) {
    choice.restoredFrom = objectId;
    choice.provenance.origin = 'restore';
  }
  yield sql('UPDATE sync_control SET applying=1 WHERE id=1');
  yield* projectFinancial(localId, choice, dialect);
  yield* recordFinancialRevision(
    choice.entityType,
    localId,
    choice,
    uuid,
    recover ? undefined : expectedHeads,
  );
  yield sql('UPDATE sync_control SET applying=0 WHERE id=1');
}

function* priorityReference(
  objectId: string,
  dialect: 'desktop' | 'android',
): Generator<
  { sql: string; params?: (string | number | null)[] },
  string | null,
  SqlRow[]
> {
  const [known] = yield sql(
    'SELECT local_id FROM sync_identity WHERE object_id=?',
    [objectId],
  );
  if (known) {
    const reference = yield* localReference(objectId);
    if (reference === null) return null;
    const [present] = yield sql('SELECT id FROM transactions WHERE id=?', [
      known.local_id,
    ]);
    if (present) return reference;
    // An archived/generated identity can exist before its disposable financial cache.
    // Materialize the same slot below instead of inserting a priority with a dangling FK.
  }
  const [slot] = yield sql('SELECT * FROM sync_slots WHERE object_id=?', [
    objectId,
  ]);
  if (!slot) throw new Error('missing_dependencies');
  if (known && known.local_id !== slot.local_id)
    throw new Error('slot_identity_collision');
  const [present] = yield sql('SELECT id FROM transactions WHERE id=?', [
    slot.local_id,
  ]);
  if (!present) {
    const heads = yield sql(
      'SELECT r.payload_json FROM sync_heads h JOIN sync_revisions r USING(revision_id) WHERE h.object_id=?',
      [slot.series_id],
    );
    if (heads.length !== 1) throw new Error('missing_dependencies');
    const parent = JSON.parse(
      String(heads[0].payload_json),
    ) as RevisionPlaintext;
    if (
      parent.action !== 'put' ||
      parent.entityType !== 'recurring' ||
      !slot.original_date
    )
      throw new Error('missing_dependencies');
    const s = parent.snapshot as Snapshots['recurring'];
    let card: { dueDay: number; closingDay: number | null } | undefined;
    if (s.cardId) {
      const local = yield* localReference(s.cardId);
      const [r] = yield sql(
        'SELECT due_day,closing_day FROM cards WHERE id=?',
        [local],
      );
      card = {
        dueDay: Number(r.due_day),
        closingDay: r.closing_day as number | null,
      };
    }
    const occurrence = recurringOccurrence(s, String(slot.original_date), card);
    const tx: RevisionPlaintext = {
      ...parent,
      entityType: 'transaction',
      snapshot: {
        kind: s.kind,
        description: s.description,
        categoryId: s.categoryId,
        paymentMethodId: s.paymentMethodId,
        cardId: s.cardId,
        plannedAmountCents: s.plannedAmountCents,
        actualAmountCents: null,
        purchaseDate: occurrence.purchaseDate,
        dueDate: occurrence.dueDate,
        settledDate: null,
        status: 'planned',
        notes: s.notes,
        source: {
          type: 'recurring',
          seriesId: String(slot.series_id),
          slotKey: String(slot.slot_key),
        },
        installmentNumber: null,
        installmentTotal: null,
        occurrenceDate: String(slot.original_date),
      },
    };
    yield* projectFinancial(String(slot.local_id), tx, dialect);
  }
  yield sql(
    "INSERT INTO sync_identity VALUES('transaction',?,?) ON CONFLICT(object_id) DO NOTHING",
    [slot.local_id, objectId],
  );
  return String(slot.local_id);
}
