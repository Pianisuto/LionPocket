import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addDays, addMonths } from '@lionpocket/core';
import {
  canonicalStringify,
  type CommitEnvelope,
} from '@lionpocket/sync-protocol';
import {
  applyCommit,
  captureFinancial,
  financialTableTypes,
  startFinancialBaseline,
  type DecodedOperation,
  type LocalSyncDatabase,
  type ProvisionedProfile,
  type SqlRow,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
import { sqliteTestConnection } from '../../../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../../../mobile/src/db/migrations';
import { mobileSyncDatabase } from '../../../../mobile/src/sync/database';
import { MobileRepository } from '../../../../mobile/src/db/repository';

function profile(pin?: ProvisionedProfile['pin']): ProvisionedProfile {
  return {
    formatVersion: 1,
    installationId: randomUUID(),
    deviceId: randomUUID(),
    signingPublicKey: '',
    boxPublicKey: '',
    pin: pin ?? {
      serverId: randomUUID(),
      serverEpoch: randomUUID(),
      vaultId: randomUUID(),
      founderDeviceId: randomUUID(),
      authorityPublicKey: 'A'.repeat(43),
      keyVersion: 1,
    },
    grants: [],
    checkpoint: { version: '1', sha256: 'A'.repeat(43) },
  };
}
const tables = Object.keys(financialTableTypes);
async function dump(db: LocalSyncDatabase): Promise<Record<string, SqlRow[]>> {
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (t) => [
        t,
        await db.read(
          `SELECT * FROM ${t} ORDER BY ${t.endsWith('priorities') ? 'recurring_id' : t === 'transaction_priority_order' ? 'month,position' : 'id'}`,
        ),
      ]),
    ),
  );
}
async function activate(db: LocalSyncDatabase, p: ProvisionedProfile) {
  await db.run(
    startFinancialBaseline(
      p,
      'https://fixture.invalid',
      '/private/automatic-backup.sqlite',
      randomUUID,
    ),
  );
}
async function deliver(
  from: LocalSyncDatabase,
  to: LocalSyncDatabase,
  p: ProvisionedProfile,
  dialect: 'desktop' | 'android',
) {
  for (const row of await from.read(
    'SELECT * FROM sync_outbox ORDER BY length(local_seq),local_seq',
  )) {
    const operations = JSON.parse(String(row.payload_json))
      .operations as DecodedOperation[];
    expect(operations.length).toBeLessThanOrEqual(100);
    await to.run(
      applyCommit(
        {
          commitId: row.commit_id,
          deviceId: p.deviceId,
          deviceSeq: row.local_seq,
        } as CommitEnvelope,
        String(row.local_seq),
        '1',
        operations,
        dialect,
        randomUUID,
      ),
    );
    for (const op of operations.filter(
      (op) =>
        op.revision.action === 'put' &&
        op.revision.entityType === 'transaction' &&
        op.revision.provenance.origin === 'migration' &&
        op.revision.provenance.legacyDeletedAt,
    )) {
      const [archived] = await to.read(
        "SELECT t.deleted_at FROM transactions t JOIN sync_identity i ON i.local_id=t.id WHERE i.entity_type='transaction' AND i.object_id=?",
        [op.objectId],
      );
      // An interruption between archival snapshots and tombstones must never make a deletion visible again.
      const conflict = await to.read(
        'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
        [op.objectId],
      );
      if (conflict.length) expect(archived.deleted_at).not.toBeNull();
      else
        expect(archived.deleted_at).toBe(
          op.revision.provenance.legacyDeletedAt,
        );
    }
  }
}
const renames: Record<string, string> = {
  planned_cents: 'planned_amount_cents',
  actual_cents: 'actual_amount_cents',
  installment_cents: 'installment_amount_cents',
  target_cents: 'target_amount_cents',
  saved_cents: 'saved_amount_cents',
};
async function copyToAndroid(
  data: Record<string, SqlRow[]>,
  db: LocalSyncDatabase,
) {
  await db.run(
    (function* () {
      for (const table of tables) {
        for (const row of data[table]) {
          const catalog = ['categories', 'payment_methods', 'cards'].includes(
            table,
          );
          const entries = Object.entries(row)
            .filter(
              ([key]) =>
                !catalog || !['created_at', 'updated_at'].includes(key),
            )
            .map(([key, value]) => [renames[key] ?? key, value] as const);
          yield {
            sql: `INSERT INTO ${table}(${entries.map((e) => e[0]).join(',')}) VALUES(${entries.map(() => '?').join(',')})`,
            params: entries.map((e) => e[1]),
          };
        }
      }
    })(),
  );
}
async function semantic(db: LocalSyncDatabase) {
  const data = await dump(db);
  const reference = (table: string, id: unknown) =>
    data[table].find((r) => r.id === id)?.name ??
    data[table].find((r) => r.id === id)?.description ??
    null;
  return Object.fromEntries(
    tables.map((table) => [
      table,
      data[table]
        .map((row) => {
          const result: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            if (
              ['id', 'created_at', 'updated_at', 'occurrence_date'].includes(
                key,
              )
            )
              continue;
            if (key === 'category_id')
              result[key] = reference('categories', value);
            else if (key === 'payment_method_id')
              result[key] = reference('payment_methods', value);
            else if (key === 'card_id') result[key] = reference('cards', value);
            else if (key === 'recurring_id')
              result[key] = reference('recurring_expenses', value);
            else if (key === 'transaction_id')
              result[key] = reference('transactions', value);
            else if (key === 'source_id')
              result[key] =
                row.source_type === 'recurring'
                  ? reference('recurring_expenses', value)
                  : row.source_type === 'installment'
                    ? reference('installment_purchases', value)
                    : null;
            else result[renames[key] ?? key] = value;
          }
          return canonicalStringify(result);
        })
        .sort(),
    ]),
  );
}
function fixture(bank: LionPocketDatabase) {
  bank.db.exec(
    'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
  );
  const insert = (table: string, row: SqlRow) =>
    bank.db
      .prepare(
        `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(row));
  const timestamps = {
    created_at: '2000-01-01 08:15:00',
    updated_at: '2020-10-01 10:30:00',
  };
  insert('categories', {
    id: 'old-category',
    name: 'Casa 🦁',
    kind: 'expense',
    color: '#123456',
    ...timestamps,
  });
  insert('payment_methods', {
    id: 'old-method',
    name: 'Pagamento antigo',
    ...timestamps,
  });
  insert('cards', {
    id: 'old-card',
    name: 'Cartão antigo',
    due_day: 10,
    closing_day: 3,
    ...timestamps,
  });
  const refs = {
    category_id: 'old-category',
    payment_method_id: 'old-method',
    card_id: 'old-card',
  };
  const tx = (
    id: string,
    date: string,
    source: string,
    series: string | null,
    index: number,
  ) => ({
    id,
    kind: 'expense',
    description: id,
    planned_cents: 1234 + index,
    actual_cents: index % 3 === 0 ? (index % 9 === 0 ? 0 : 500) : null,
    status:
      index % 3 === 0 ? 'paid' : index % 7 === 0 ? 'cancelled' : 'planned',
    purchase_date: null,
    due_date: date,
    settled_date: index % 3 === 0 ? date : null,
    notes: 'Histórico preservado 🦁',
    source_type: source,
    source_id: series,
    deleted_at: index % 23 === 0 ? '2020-12-01 11:12:13' : null,
    ...refs,
    ...timestamps,
  });
  for (let s = 0; s < 11; s++) {
    const frequency =
      s < 8 ? 'monthly' : s === 8 ? 'weekly' : s === 9 ? 'custom' : 'manual';
    insert('recurring_expenses', {
      id: `old-series-${s}`,
      kind: 'expense',
      active: 1,
      description: `Série ${s}`,
      planned_cents: 1234,
      start_month: '2000-01',
      start_date: s < 8 ? '2000-01-10' : '2000-01-13',
      due_day: 10,
      frequency,
      interval_count: s === 9 ? 11 : 1,
      interval_unit: s === 9 ? 'days' : 'months',
      anchor_to_actual: s === 9 ? 1 : 0,
      manual_months: frequency === 'manual' ? '02,05,09' : '',
      notes: '',
      ...refs,
      ...timestamps,
    });
    const count = s < 8 ? 240 : 500;
    for (let i = 0; i < count; i++) {
      // Today's due day does not describe this series' history. Card cycle / purchase date also changed.
      const date =
        s < 8 || s === 10
          ? addMonths(`2000-01-${i % 2 ? '19' : '05'}`, i)
          : addDays('2000-01-10', i * (s === 8 ? 7 : 17));
      insert(
        'transactions',
        tx(`old-recurring-${s}-${i}`, date, 'recurring', `old-series-${s}`, i),
      );
    }
  }
  for (let p = 0; p < 4; p++) {
    insert('installment_purchases', {
      id: `old-purchase-${p}`,
      description: `Compra ${p}`,
      installment_cents: 1000,
      total_installments: 24,
      starting_installment: 3,
      purchase_date: '2018-12-01',
      first_due_date: '2019-01-10',
      status: 'active',
      notes: '',
      ...refs,
      ...timestamps,
    });
    for (let i = 0; i < 24; i++)
      insert('transactions', {
        ...tx(
          `old-installment-${p}-${i}`,
          addMonths('2019-01-10', i),
          'installment',
          `old-purchase-${p}`,
          i,
        ),
        installment_number: i < 6 ? i + 1 : i < 12 ? i - 4 : i + 1,
        installment_total: 24,
      });
  }
  insert('transactions', {
    ...tx(
      'old-deleted-recurring-duplicate',
      '2000-02-19',
      'recurring',
      'old-series-0',
      1,
    ),
    deleted_at: '2020-12-01 11:12:13',
  });
  insert('transactions', {
    ...tx(
      'old-deleted-installment-duplicate',
      '2019-02-10',
      'installment',
      'old-purchase-0',
      1,
    ),
    installment_number: 2,
    installment_total: 24,
    deleted_at: '2020-12-01 11:12:13',
  });
  for (let i = 0; i < 600; i++)
    insert(
      'transactions',
      tx(
        `old-independent-${i}`,
        addDays('2020-01-01', i),
        i < 300 ? 'imported' : 'manual',
        i < 300 ? `xlsx:lost-file:${i}` : null,
        i,
      ),
    );
  insert('transaction_priority_order', {
    month: '2000-01',
    transaction_id: 'old-recurring-0-1',
    position: 0,
    ...timestamps,
  });
  insert('recurring_transaction_priorities', {
    recurring_id: 'old-series-0',
    position: 0,
    pinned_from_month: '2000-01',
    ...timestamps,
  });
  insert('goals', {
    id: 'old-goal',
    name: 'Reserva',
    target_cents: 10000,
    saved_cents: 2345,
    category_id: 'old-category',
    priority: 'high',
    status: 'saving',
    ...timestamps,
  });
}

describe('zero-touch legacy financial adoption', () => {
  it.each(['desktop', 'android'] as const)(
    'adopts >4,000 legacy rows on %s and converges to an empty second bank without changing the source',
    async (dialect) => {
      const desktop = new LionPocketDatabase(':memory:');
      const mobile = sqliteTestConnection();
      try {
        await migrate(mobile.db);
        mobile.sqlite.exec(
          'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
        );
        fixture(desktop);
        const db = desktop.syncDatabase(),
          mb = mobileSyncDatabase(mobile.db);
        if (dialect === 'android') {
          await copyToAndroid(await dump(db), mb);
          desktop.db.exec(
            'DELETE FROM transaction_priority_order; DELETE FROM recurring_transaction_priorities; DELETE FROM transactions; DELETE FROM goals; DELETE FROM recurring_expenses; DELETE FROM installment_purchases; DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
          );
        }
        const source = dialect === 'desktop' ? db : mb,
          target = dialect === 'desktop' ? mb : db;
        const original = await dump(source),
          expected = await semantic(source),
          p = profile(),
          second = profile(p.pin);
        expect(original.transactions.length).toBeGreaterThan(4000);
        await activate(source, p);
        await activate(target, second);
        expect(await dump(source)).toEqual(original);
        expect(await source.read('SELECT * FROM sync_review')).toEqual([]);
        expect(
          await source.read(
            "SELECT * FROM sync_series WHERE identity_status!='resolved'",
          ),
        ).toEqual([]);
        expect(
          (
            await source.read(
              'SELECT * FROM sync_slots WHERE local_id LIKE ?',
              ['old-%'],
            )
          ).length,
        ).toBe(
          original.transactions.filter((t) =>
            ['recurring', 'installment'].includes(String(t.source_type)),
          ).length,
        );
        expect(
          await source.read("SELECT * FROM sync_outbox WHERE state!='pending'"),
        ).toEqual([]);
        expect(
          (await source.read('SELECT * FROM sync_bootstrap'))[0],
        ).toMatchObject({
          state: 'captured',
          backup_path: '/private/automatic-backup.sqlite',
        });
        await deliver(
          source,
          target,
          p,
          dialect === 'desktop' ? 'android' : 'desktop',
        );
        expect(await semantic(target)).toEqual(expected);
        expect(
          await target.read(
            'SELECT * FROM sync_conflicts WHERE resolution_id IS NULL',
          ),
        ).toEqual([]);
        expect(await target.read('PRAGMA foreign_key_check')).toEqual([]);
        // Exact replay is idempotent. Reading historical months does not add duplicate caches.
        await deliver(
          source,
          target,
          p,
          dialect === 'desktop' ? 'android' : 'desktop',
        );
        expect(await semantic(target)).toEqual(expected);
        const count = (
          await target.read('SELECT count(*) AS n FROM transactions')
        )[0].n;
        // All historic agendas differ from today's: weekly anchor, custom
        // interval/actual anchor, manual months, monthly day/card cycle.
        for (const month of [
          '2000-02',
          '2000-05',
          '2001-09',
          '2005-10',
          '2025-09',
        ]) {
          if (dialect === 'desktop')
            await new MobileRepository(mobile.db, randomUUID).list({ month });
          else desktop.listTransactions({ month });
          expect(
            (await target.read('SELECT count(*) AS n FROM transactions'))[0].n,
          ).toBe(count);
        }
        const monthlyRows = await target.read(
          "SELECT t.* FROM transactions t JOIN recurring_expenses r ON r.id=t.source_id WHERE r.frequency='monthly'",
        );
        expect(monthlyRows).toHaveLength(1921);
        expect(
          Number(
            (await target.read('SELECT count(*) AS n FROM transactions'))[0].n,
          ),
        ).toBe(Number(count));
        const stable = await source.read(
          'SELECT local_id,object_id,slot_key FROM sync_slots ORDER BY local_id',
        );
        await source.run(captureFinancial(randomUUID));
        expect(
          await source.read(
            'SELECT local_id,object_id,slot_key FROM sync_slots ORDER BY local_id',
          ),
        ).toEqual(stable);
        expect(await dump(source)).toEqual(original);
        // Later aggregate edits must not manufacture missing historic installments from today's numbering.
        const targetBefore = await semantic(target);
        await source.run(
          (function* () {
            yield { sql: "UPDATE installment_purchases SET notes='Nota nova'" };
            yield* captureFinancial(randomUUID);
          })(),
        );
        await deliver(
          source,
          target,
          p,
          dialect === 'desktop' ? 'android' : 'desktop',
        );
        expect((await semantic(target)).transactions).toEqual(
          targetBefore.transactions,
        );
        expect((await semantic(target)).installment_purchases).toEqual(
          (await semantic(source)).installment_purchases,
        );
        // Editing an adopted occurrence on the receiving device retains its shared object and slot.
        const [originalIdentity] = await source.read(
          "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id='old-recurring-0-2'",
        );
        const [receivingIdentity] = await target.read(
          'SELECT local_id FROM sync_identity WHERE object_id=?',
          [originalIdentity.object_id],
        );
        await target.run(
          (function* () {
            yield {
              sql: `UPDATE transactions SET actual_${dialect === 'desktop' ? 'amount_cents' : 'cents'}=123,status='paid',settled_date=due_date WHERE id=?`,
              params: [receivingIdentity.local_id],
            };
            yield* captureFinancial(randomUUID);
          })(),
        );
        await deliver(target, source, second, dialect);
        expect(
          (
            await source.read(
              "SELECT * FROM transactions WHERE id='old-recurring-0-2'",
            )
          )[0].status,
        ).toBe('paid');
        expect(
          (await source.read('SELECT count(*) AS n FROM transactions'))[0].n,
        ).toBe(original.transactions.length);
        // Coverage ends at the adopted horizon; it is not a permanent generation freeze.
        const counts = () =>
          target.read(
            'SELECT r.frequency,count(*) AS n FROM transactions t JOIN recurring_expenses r ON r.id=t.source_id GROUP BY r.frequency',
          );
        const beforeFuture = await counts();
        if (dialect === 'desktop')
          await new MobileRepository(mobile.db, randomUUID).list({
            month: '2042-06',
          });
        else desktop.listTransactions({ month: '2042-06' });
        const afterFuture = await counts();
        for (const row of beforeFuture)
          expect(
            Number(afterFuture.find((r) => r.frequency === row.frequency)!.n),
          ).toBeGreaterThan(Number(row.n));
      } finally {
        desktop.db.close();
        mobile.sqlite.close();
      }
    },
    60000,
  );

  it('automatically resumes an older baseline with unresolved series, import/delete and dependency reviews', async () => {
    const bank = new LionPocketDatabase(':memory:'),
      target = new LionPocketDatabase(':memory:');
    try {
      const p = profile();
      await activate(bank.syncDatabase(), p);
      bank.db.exec('UPDATE sync_control SET applying=1');
      bank.saveRecurringExpense({
        kind: 'expense',
        active: true,
        description: 'Antes do sync',
        plannedAmount: 10,
        startMonth: '2026-10',
        dueDay: 10,
      });
      bank.listTransactions({ month: '2026-10' });
      const series = bank.db.prepare('SELECT * FROM recurring_expenses').get()!;
      const tx = bank.db.prepare('SELECT * FROM transactions').get()!;
      const imported = bank.saveTransaction({
        kind: 'expense',
        description: 'Import antigo excluído',
        plannedAmount: 3,
        dueDate: '2026-10-11',
        status: 'planned',
      });
      bank.db
        .prepare(
          "UPDATE transactions SET source_type='imported',source_id='old:unverifiable',deleted_at='2026-10-01 10:00:00' WHERE id=?",
        )
        .run(imported.id);
      bank.db
        .prepare('INSERT INTO sync_series VALUES(?,?,?,?,?)')
        .run('recurring', series.id, randomUUID(), '{}', 'identity_unresolved');
      const legacyId = randomUUID();
      bank.db
        .prepare("INSERT INTO sync_identity VALUES('transaction',?,?)")
        .run(tx.id, legacyId);
      bank.setTransactionPriority({
        month: '2026-10',
        transactionId: String(tx.id),
        pinned: true,
      });
      const review = (reason: string, table: string, id: string) =>
        bank.db
          .prepare('INSERT INTO sync_review VALUES(?,?,?,?)')
          .run(
            randomUUID(),
            null,
            reason,
            canonicalStringify({ table, localId: id }),
          );
      review('identity_unresolved', 'recurring_expenses', String(series.id));
      review('identity_unresolved', 'transactions', String(tx.id));
      review('import_provenance_review', 'transactions', imported.id);
      review('legacy_delete_review', 'transactions', imported.id);
      review(
        'dependency_review_required',
        'transaction_priority_order',
        '2026-10',
      );
      review(
        'dependency_review_required',
        'recurring_transaction_priorities',
        'recurring-priorities',
      );
      bank.db.exec(
        'DELETE FROM sync_dirty; UPDATE sync_control SET applying=0',
      );
      const original = await dump(bank.syncDatabase());
      await bank.syncDatabase().run(captureFinancial(randomUUID));
      expect(await dump(bank.syncDatabase())).toEqual(original);
      expect(bank.db.prepare('SELECT * FROM sync_review').all()).toEqual([]);
      expect(
        bank.db
          .prepare(
            "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
          )
          .get(tx.id)?.object_id,
      ).toBe(legacyId);
      expect(
        bank.db
          .prepare(
            'SELECT legacy_key FROM sync_import_provenance WHERE local_id=?',
          )
          .get(imported.id)?.legacy_key,
      ).toBe('old:unverifiable');
      // No global approval step, including a persisted gate left by the previous version.
      bank.db.exec("UPDATE sync_bootstrap SET state='joining_review'");
      target.db.exec(
        'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
      );
      await activate(target.syncDatabase(), profile(p.pin));
      await deliver(bank.syncDatabase(), target.syncDatabase(), p, 'desktop');
      expect(await semantic(target.syncDatabase())).toEqual(
        await semantic(bank.syncDatabase()),
      );
    } finally {
      bank.db.close();
      target.db.close();
    }
  });

  it('resumes >100 unpublished dependency-only reviews without batch_too_large', async () => {
    const a = new LionPocketDatabase(':memory:'),
      b = new LionPocketDatabase(':memory:');
    try {
      const p = profile();
      await activate(a.syncDatabase(), p);
      a.db.exec('UPDATE sync_control SET applying=1');
      for (let i = 0; i < 250; i++) {
        const tx = a.saveTransaction({
          kind: 'expense',
          description: `Dependência antiga ${i}`,
          plannedAmount: i + 1,
          dueDate: '2026-10-10',
          status: 'planned',
        });
        const objectId = randomUUID();
        a.db
          .prepare("INSERT INTO sync_identity VALUES('transaction',?,?)")
          .run(tx.id, objectId);
        a.db
          .prepare('INSERT INTO sync_review VALUES(?,?,?,?)')
          .run(
            randomUUID(),
            objectId,
            'dependency_review_required',
            canonicalStringify({ table: 'transactions', localId: tx.id }),
          );
      }
      a.db.exec('DELETE FROM sync_dirty; UPDATE sync_control SET applying=0');
      const before = await dump(a.syncDatabase());
      await a.syncDatabase().run(captureFinancial(randomUUID));
      expect(await dump(a.syncDatabase())).toEqual(before);
      expect(a.db.prepare('SELECT * FROM sync_review').all()).toEqual([]);
      expect(
        a.db.prepare("SELECT * FROM sync_outbox WHERE state='blocked'").all(),
      ).toEqual([]);
      b.db.exec(
        'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards',
      );
      await activate(b.syncDatabase(), profile(p.pin));
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(await semantic(b.syncDatabase())).toEqual(
        await semantic(a.syncDatabase()),
      );
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it('retains the atomic limit when dependency reviews refer to already-published versions', async () => {
    const bank = new LionPocketDatabase(':memory:');
    try {
      for (let i = 0; i < 101; i++)
        bank.saveTransaction({
          kind: 'expense',
          description: `Versão ${i}`,
          plannedAmount: 1,
          dueDate: '2026-10-10',
          status: 'planned',
        });
      await activate(bank.syncDatabase(), profile());
      bank.db.exec(
        'UPDATE sync_control SET applying=1; UPDATE transactions SET planned_cents=200',
      );
      for (const identity of bank.db
        .prepare("SELECT * FROM sync_identity WHERE entity_type='transaction'")
        .all())
        bank.db
          .prepare('INSERT INTO sync_review VALUES(?,?,?,?)')
          .run(
            randomUUID(),
            identity.object_id,
            'dependency_review_required',
            canonicalStringify({
              table: 'transactions',
              localId: identity.local_id,
            }),
          );
      bank.db.exec(
        'DELETE FROM sync_dirty; UPDATE sync_control SET applying=0',
      );
      await bank.syncDatabase().run(captureFinancial(randomUUID));
      expect(
        bank.db
          .prepare(
            "SELECT * FROM sync_outbox WHERE state='blocked' AND last_error='batch_too_large'",
          )
          .all(),
      ).toHaveLength(101);
      expect(
        bank.db
          .prepare(
            'SELECT count(*) AS n FROM transactions WHERE planned_cents=200',
          )
          .get()!.n,
      ).toBe(101);
    } finally {
      bank.db.close();
    }
  });

  it('gives copies of the same unsynchronized rows identical slots, epochs and synthetic import keys', async () => {
    const a = new LionPocketDatabase(':memory:'),
      b = new LionPocketDatabase(':memory:');
    try {
      a.saveRecurringExpense({
        kind: 'expense',
        active: true,
        description: 'Copiada',
        plannedAmount: 10,
        startMonth: '2026-10',
        dueDay: 10,
      });
      a.listTransactions({ month: '2026-10' });
      const tx = a.saveTransaction({
        kind: 'expense',
        description: 'Import copiado',
        plannedAmount: 10,
        dueDate: '2026-10-10',
        status: 'planned',
      });
      a.db
        .prepare(
          "UPDATE transactions SET source_type='imported',source_id='lost.xlsx:42' WHERE id=?",
        )
        .run(tx.id);
      const deleted = a.saveTransaction({
        kind: 'expense',
        description: 'Exclusão copiada',
        plannedAmount: 12.34,
        dueDate: '2026-09-10',
        status: 'paid',
        actualAmount: 11,
        settledDate: '2026-09-12',
      });
      a.db
        .prepare('UPDATE transactions SET deleted_at=? WHERE id=?')
        .run('2026-09-20 11:22:33', deleted.id);
      a.saveInstallmentPurchase({
        description: 'Parcelas copiadas',
        installmentAmount: 10,
        totalInstallments: 3,
        currentInstallment: 2,
        currentDueDate: '2026-10-10',
      });
      a.db.exec(
        "UPDATE transactions SET deleted_at='2026-09-20 11:22:33' WHERE source_type='recurring' OR (source_type='installment' AND installment_number=2)",
      );
      const original = await dump(a.syncDatabase());
      b.db.exec(
        'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
      );
      for (const [table, rows] of Object.entries(await dump(a.syncDatabase())))
        for (const row of rows)
          b.db
            .prepare(
              `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(
                row,
              )
                .map(() => '?')
                .join(',')})`,
            )
            .run(...Object.values(row));
      const p = profile(),
        q = profile(p.pin);
      await activate(a.syncDatabase(), p);
      await activate(b.syncDatabase(), q);
      for (const table of [
        'sync_identity',
        'sync_slots',
        'sync_series',
        'sync_import_provenance',
      ])
        expect(
          a.db.prepare(`SELECT * FROM ${table} ORDER BY local_id`).all(),
        ).toEqual(
          b.db.prepare(`SELECT * FROM ${table} ORDER BY local_id`).all(),
        );
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(
        b.db.prepare('SELECT count(*) AS n FROM transactions').get()!.n,
      ).toBe(original.transactions.length);
      await deliver(b.syncDatabase(), a.syncDatabase(), q, 'desktop');
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      for (const bank of [a, b]) {
        expect(
          bank.db
            .prepare('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')
            .all(),
        ).toEqual([]);
        expect(
          bank.db.prepare('SELECT count(*) AS n FROM transactions').get()!.n,
        ).toBe(original.transactions.length);
        expect(
          bank.db
            .prepare(
              'SELECT deleted_at,actual_cents,due_date,settled_date FROM transactions WHERE id=?',
            )
            .get(deleted.id),
        ).toEqual({
          deleted_at: '2026-09-20 11:22:33',
          actual_cents: 1100,
          due_date: '2026-09-10',
          settled_date: '2026-09-12',
        });
      }
      expect(
        b.db
          .prepare('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')
          .all(),
      ).toEqual([]);
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it.each(['different financial history', 'a live version'])(
    'keeps a real conflict when a legacy deletion meets %s',
    async (variant) => {
      const a = new LionPocketDatabase(':memory:'),
        b = new LionPocketDatabase(':memory:');
      try {
        const tx = a.saveTransaction({
          kind: 'expense',
          description: 'Versões reais',
          plannedAmount: 10,
          dueDate: '2026-09-10',
          status: 'paid',
          actualAmount: 9,
          settledDate: '2026-09-11',
        });
        a.db
          .prepare('UPDATE transactions SET deleted_at=? WHERE id=?')
          .run('2026-09-20 11:22:33', tx.id);
        b.db.exec(
          'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards',
        );
        for (const [table, rows] of Object.entries(
          await dump(a.syncDatabase()),
        ))
          for (const row of rows)
            b.db
              .prepare(
                `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(
                  row,
                )
                  .map(() => '?')
                  .join(',')})`,
              )
              .run(...Object.values(row));
        b.db
          .prepare(
            variant === 'a live version'
              ? 'UPDATE transactions SET deleted_at=NULL WHERE id=?'
              : 'UPDATE transactions SET actual_cents=777 WHERE id=?',
          )
          .run(tx.id);
        const p = profile(),
          q = profile(p.pin);
        await activate(a.syncDatabase(), p);
        await activate(b.syncDatabase(), q);
        await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
        await deliver(b.syncDatabase(), a.syncDatabase(), q, 'desktop');
        for (const bank of [a, b]) {
          const objectId = bank.db
            .prepare(
              "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
            )
            .get(tx.id)!.object_id;
          expect(
            bank.db
              .prepare(
                'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
              )
              .all(objectId),
          ).toHaveLength(1);
          expect(
            bank.db
              .prepare('SELECT deleted_at FROM transactions WHERE id=?')
              .get(tx.id)!.deleted_at,
          ).not.toBeNull();
        }
      } finally {
        a.db.close();
        b.db.close();
      }
    },
  );

  it('rolls back an interrupted activation and keeps deleted series history without cascading legacy deletes', async () => {
    const a = new LionPocketDatabase(':memory:'),
      b = new LionPocketDatabase(':memory:');
    try {
      a.saveRecurringExpense({
        kind: 'expense',
        active: true,
        description: 'Série excluída',
        plannedAmount: 10,
        startMonth: '2026-10',
        dueDay: 10,
      });
      a.listTransactions({ month: '2026-10' });
      a.db.exec(
        "UPDATE recurring_expenses SET deleted_at='2026-10-02 01:02:03'",
      );
      const original = await dump(a.syncDatabase()),
        p = profile();
      a.db.exec(
        "CREATE TRIGGER fail_baseline BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'disk-full'); END",
      );
      await expect(activate(a.syncDatabase(), p)).rejects.toThrow('disk-full');
      expect(await dump(a.syncDatabase())).toEqual(original);
      expect(
        a.db.prepare('SELECT mode,binding_id FROM sync_local_state').get(),
      ).toMatchObject({ mode: 'disabled', binding_id: null });
      expect(a.db.prepare('SELECT * FROM sync_identity').all()).toEqual([]);
      a.db.exec('DROP TRIGGER fail_baseline');
      await activate(a.syncDatabase(), p);
      b.db.exec(
        'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
      );
      await activate(b.syncDatabase(), profile(p.pin));
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(await semantic(b.syncDatabase())).toEqual(
        await semantic(a.syncDatabase()),
      );
      expect(
        b.db.prepare('SELECT deleted_at FROM transactions').get()?.deleted_at,
      ).toBeNull();
    } finally {
      a.db.close();
      b.db.close();
    }
  });

  it('reconciles identical catalog adoption roots while retaining different properties and true concurrent edits', async () => {
    const a = new LionPocketDatabase(':memory:'),
      b = new LionPocketDatabase(':memory:');
    try {
      const p = profile(),
        q = profile(p.pin);
      await activate(a.syncDatabase(), p);
      await activate(b.syncDatabase(), q);
      const initial = b.db
        .prepare('SELECT count(*) AS n FROM categories')
        .get()!.n;
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(
        b.db.prepare('SELECT count(*) AS n FROM categories').get()!.n,
      ).toBe(initial);
      expect(
        b.db
          .prepare('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')
          .all(),
      ).toEqual([]);
      // Same name with genuinely different billing properties must remain distinct.
      a.createCatalogItem({
        type: 'card',
        name: 'Mesmo cartão',
        dueDay: 10,
        closingDay: 2,
      });
      b.createCatalogItem({
        type: 'card',
        name: 'Mesmo cartão',
        dueDay: 20,
        closingDay: 5,
      });
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(
        b.db
          .prepare('SELECT due_day,closing_day FROM cards ORDER BY due_day')
          .all(),
      ).toMatchObject([
        { due_day: 10, closing_day: 2 },
        { due_day: 20, closing_day: 5 },
      ]);
      expect(
        b.db
          .prepare(
            "SELECT * FROM sync_review WHERE reason='catalog_identity_review'",
          )
          .all(),
      ).toEqual([]);
      const category = a.db
        .prepare('SELECT id FROM categories ORDER BY name LIMIT 1')
        .get()!.id as string;
      const object = a.db
        .prepare(
          "SELECT object_id FROM sync_identity WHERE entity_type='category' AND local_id=?",
        )
        .get(category)!.object_id;
      const other = b.db
        .prepare('SELECT local_id FROM sync_identity WHERE object_id=?')
        .get(object)!.local_id;
      a.db
        .prepare('UPDATE categories SET name=? WHERE id=?')
        .run('Edição A', category);
      b.db
        .prepare('UPDATE categories SET name=? WHERE id=?')
        .run('Edição B', other);
      await a.syncDatabase().run(captureFinancial(randomUUID));
      await b.syncDatabase().run(captureFinancial(randomUUID));
      await deliver(a.syncDatabase(), b.syncDatabase(), p, 'desktop');
      expect(
        b.db.prepare('SELECT * FROM sync_heads WHERE object_id=?').all(object),
      ).toHaveLength(2);
      expect(
        b.db
          .prepare(
            'SELECT * FROM sync_conflicts WHERE object_id=? AND resolution_id IS NULL',
          )
          .all(object),
      ).toHaveLength(1);
    } finally {
      a.db.close();
      b.db.close();
    }
  });
});
