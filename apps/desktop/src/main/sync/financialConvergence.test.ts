import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  startFinancialBaseline,
  applyCommit,
  unlinkLocalServer,
  reconnectFinancial,
  resolveFinancial,
  type LocalSyncDatabase,
  type DecodedOperation,
} from '@lionpocket/sync-local';
import type { CommitEnvelope } from '@lionpocket/sync-protocol';
import { LionPocketDatabase } from '../database';
import { TestSecrets, founder } from '../../../../sync-server/src/testSupport';
import { sqliteTestConnection } from '../../../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../../../mobile/src/db/migrations';
import { MobileRepository } from '../../../../mobile/src/db/repository';
import { mobileSyncDatabase } from '../../../../mobile/src/sync/database';
import { captureBackup } from '../../../../mobile/src/db/backupRepository';
const close: (() => void)[] = [];
beforeAll(async () => {
  await sodium.ready;
});
afterEach(() => close.splice(0).forEach((f) => f()));
async function banks() {
  const crypto = new ProvisioningCrypto(sodium),
    { client: a } = await founder(crypto),
    b = await DeviceProvisioning.prepare(
      a.profile.pin,
      new TestSecrets(),
      crypto,
    ),
    request = await b.request(),
    grant = await a.grant(request);
  a.acceptRegistry({
    pin: a.profile.pin,
    grants: [...a.profile.grants, grant],
    delivery: null,
  });
  await b.receive({
    pin: a.profile.pin,
    grants: a.profile.grants,
    delivery: await a.delivery(b.profile.deviceId),
  });
  const desktop = new LionPocketDatabase(':memory:'),
    mobile = sqliteTestConnection();
  close.push(
    () => desktop.db.close(),
    () => mobile.sqlite.close(),
  );
  await migrate(mobile.db);
  // Empty fixture catalogs are deliberately removed before initial identity assignment.
  desktop.db.exec(
    'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
  );
  mobile.sqlite.exec(
    'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
  );
  const db = desktop.syncDatabase(),
    mb = mobileSyncDatabase(mobile.db);
  await db.run(
    startFinancialBaseline(
      a.profile,
      'https://fixture.invalid',
      '/private/fixture.sqlite',
      randomUUID,
    ),
  );
  await mb.run(
    startFinancialBaseline(
      b.profile,
      'https://fixture.invalid',
      '/private/fixture.sqlite',
      randomUUID,
    ),
  );
  return {
    desktop,
    mobile,
    repo: new MobileRepository(mobile.db, randomUUID),
    db,
    mb,
    a,
    b,
    crypto,
  };
}
async function deliver(
  from: LocalSyncDatabase,
  to: LocalSyncDatabase,
  device: DeviceProvisioning,
  dialect: 'desktop' | 'android',
) {
  const rows = await from.read(
    "SELECT * FROM sync_outbox WHERE state='pending' ORDER BY length(local_seq),local_seq",
  );
  for (const row of rows) {
    const pending = JSON.parse(String(row.payload_json)) as {
      operations: DecodedOperation[];
    };
    const envelope = {
      commitId: row.commit_id,
      deviceId: device.profile.deviceId,
      deviceSeq: row.local_seq,
    } as CommitEnvelope;
    await to.run(
      applyCommit(
        envelope,
        String(row.local_seq),
        device.profile.checkpoint!.version,
        pending.operations,
        dialect,
        randomUUID,
      ),
    );
  }
  await from.run(
    (function* () {
      yield {
        sql: "UPDATE sync_outbox SET state='acknowledged' WHERE state='pending'",
      };
    })(),
  );
}
describe('financial domain across desktop and Android repositories', () => {
  it('syncs independent monthly planning, edits, zero removal and recreation in both directions with stable identity', async () => {
    const x = await banks();
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    x.desktop.saveMonthlyPlanning({ month: '2026-11', safetyMarginCents: 30000 });
    await deliver(x.db, x.mb, x.a, 'android');
    expect(await x.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 50000 });
    const id = String((await x.db.read("SELECT object_id FROM sync_identity WHERE entity_type='monthlyPlanning' AND local_id='2026-10'"))[0].object_id);
    await x.repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 60000 });
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(x.desktop.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 60000 });
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 0 });
    await deliver(x.db, x.mb, x.a, 'android');
    expect(await x.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 0 });
    await x.repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 999 });
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(x.desktop.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 999 });
    expect(x.desktop.getMonthlyPlanning('2026-11')).toMatchObject({ safetyMarginCents: 30000 });
    expect(x.desktop.getMonthlyPlanning('2026-12')).toBeNull();
    for (const db of [x.db, x.mb]) {
      expect(await db.read("SELECT object_id FROM sync_identity WHERE entity_type='monthlyPlanning' AND local_id='2026-10'")).toEqual([{ object_id: id }]);
      expect(await db.read('SELECT * FROM sync_tombstones')).toEqual([]);
    }
  });
  it('keeps concurrent different margins as a review conflict instead of silently taking the old value', async () => {
    const x = await banks();
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    await deliver(x.db, x.mb, x.a, 'android');
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 40000 });
    await x.repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 60000 });
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(await x.db.read('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')).toHaveLength(1);
    expect(await x.mb.read('SELECT * FROM sync_conflicts WHERE resolution_id IS NULL')).toHaveLength(1);
  });
  it('preserves planning through local detach, offline edits and a fresh baseline to a different server', async () => {
    const x = await banks();
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    await deliver(x.db, x.mb, x.a, 'android');
    const before = await x.mb.read('SELECT * FROM monthly_planning');
    await x.mb.run(unlinkLocalServer());
    expect(await x.mb.read('SELECT * FROM monthly_planning')).toEqual(before);
    await x.repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 70000 });
    await x.repo.saveMonthlyPlanning({ month: '2026-11', safetyMarginCents: 30000 });
    expect(await x.mb.read('SELECT * FROM sync_outbox')).toEqual([]);
    const pin = { ...x.b.profile.pin, vaultId: randomUUID(), serverId: randomUUID() };
    await x.mb.run(startFinancialBaseline({ ...x.b.profile, pin }, 'https://new.invalid', '/fixture/new.sqlite', randomUUID));
    const values = (await x.mb.read('SELECT payload_json FROM sync_revisions')).map(row => JSON.parse(String(row.payload_json))).filter(r => r.entityType === 'monthlyPlanning');
    expect(values.map(r => r.snapshot)).toEqual(expect.arrayContaining([{ month: '2026-10', safetyMarginCents: 70000 }, { month: '2026-11', safetyMarginCents: 30000 }]));
    expect(await x.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 70000 });
  });
  it('captures offline planning edits after restoring and reconnecting the same binding', async () => {
    const x = await banks();
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    await x.db.run((function* () { yield { sql: "UPDATE sync_local_state SET mode='disabled' WHERE id=1" }; })());
    x.desktop.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 0 });
    x.desktop.saveMonthlyPlanning({ month: '2026-11', safetyMarginCents: 12345 });
    await x.db.run(reconnectFinancial(x.a.profile, 'https://fixture.invalid', '/fixture/restore.sqlite', randomUUID));
    await deliver(x.db, x.mb, x.a, 'android');
    expect(await x.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 0 });
    expect(await x.repo.getMonthlyPlanning('2026-11')).toMatchObject({ safetyMarginCents: 12345 });
  });
  it('converges catalogs, linked cents/zero/NULL/Unicode, goals, edits and deletes in both directions', async () => {
    const x = await banks();
    x.desktop.createCatalogItem({
      type: 'category',
      name: 'Comida 🦁',
      kind: 'expense',
    });
    x.desktop.createCatalogItem({ type: 'paymentMethod', name: 'Pix' });
    x.desktop.createCatalogItem({
      type: 'card',
      name: 'Cartão',
      dueDay: 10,
      closingDay: 3,
    });
    const catalogs = x.desktop.getCatalogs();
    const tx = x.desktop.saveTransaction({
      kind: 'expense',
      description: 'Café Unicode 🦁',
      plannedAmount: 12.34,
      actualAmount: 0,
      dueDate: '2026-10-10',
      settledDate: '2026-10-10',
      status: 'paid',
      categoryId: catalogs.categories[0].id,
      paymentMethodId: catalogs.paymentMethods[0].id,
      cardId: catalogs.cards[0].id,
    });
    x.desktop.saveGoal({
      name: 'Reserva',
      targetAmount: 100,
      savedAmount: 0,
      priority: 'high',
      status: 'saving',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const incoming = (await x.repo.list({ month: '2026-10' })).find(
      (t) => t.description === tx.description,
    )!;
    expect(incoming).toMatchObject({
      plannedAmount: 12.34,
      actualAmount: 0,
      categoryName: 'Comida 🦁',
      paymentMethodName: 'Pix',
      cardName: 'Cartão',
    });
    await x.repo.save({
      ...incoming,
      description: 'Edição Android',
      actualAmount: null,
      status: 'planned',
      settledDate: null,
    });
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(
      x.desktop.db
        .prepare('SELECT description,actual_cents FROM transactions WHERE id=?')
        .get(tx.id),
    ).toMatchObject({ description: 'Edição Android', actual_cents: null });
    await x.repo.remove(incoming.id);
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(
      x.desktop.db
        .prepare('SELECT deleted_at FROM transactions WHERE id=?')
        .get(tx.id)?.deleted_at,
    ).toBeTruthy();
    expect(x.desktop.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      (await captureBackup(x.mobile.db)).data.sync_tombstones,
    ).toHaveLength(1);
  });
  it('materializes the same monthly recurring occurrence offline without publishing caches', async () => {
    const x = await banks();
    x.desktop.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Mensal',
      plannedAmount: 10,
      startMonth: '2026-10',
      dueDay: 31,
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const da = x.desktop.listTransactions({ month: '2026-10' }),
      ma = await x.repo.list({ month: '2026-10' });
    expect(da.filter((t) => t.description === 'Mensal')).toHaveLength(1);
    expect(ma.filter((t) => t.description === 'Mensal')).toHaveLength(1);
    const d = x.desktop.db
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(da.find((t) => t.description === 'Mensal')!.id),
      m = x.mobile.sqlite
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(ma.find((t) => t.description === 'Mensal')!.id);
    expect(d?.object_id).toBe(m?.object_id);
    expect(d?.object_id).toBeTruthy();
    expect(
      (
        await x.db.read(
          "SELECT payload_json FROM sync_outbox WHERE state='pending'",
        )
      ).every((r) =>
        JSON.parse(String(r.payload_json)).operations.every(
          (o: DecodedOperation) => o.revision.entityType !== 'transaction',
        ),
      ),
    ).toBe(true);
    expect(
      (
        await x.mb.read(
          "SELECT payload_json FROM sync_outbox WHERE state='pending'",
        )
      ).every((r) =>
        JSON.parse(String(r.payload_json)).operations.every(
          (o: DecodedOperation) => o.revision.entityType !== 'transaction',
        ),
      ),
    ).toBe(true);
  });
  it('keeps installment slots stable and records settlement batches as an indivisible commit', async () => {
    const x = await banks();
    x.desktop.saveInstallmentPurchase({
      description: 'Notebook',
      installmentAmount: 12.34,
      totalInstallments: 4,
      currentInstallment: 2,
      currentDueDate: '2026-10-10',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const month = x.desktop.listTransactions({ month: '2026-10' }),
      other = await x.repo.list({ month: '2026-10' });
    expect(month.filter((t) => t.description === 'Notebook')).toHaveLength(1);
    expect(other.filter((t) => t.description === 'Notebook')).toHaveLength(1);
    expect(other.find((t) => t.description === 'Notebook')).toMatchObject({
      installmentNumber: 2,
      plannedAmount: 12.34,
    });
    const purchase = x.desktop.listInstallmentPurchases('2026-10')[0];
    const slotBefore = x.desktop.db
      .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
      .get(month.find((t) => t.description === 'Notebook')!.id)?.object_id;
    x.desktop.saveInstallmentPurchase({
      ...purchase,
      currentInstallment: 3,
      originalCurrentInstallment: 2,
      currentDueDate: '2026-10-10',
      totalInstallments: 5,
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const renumbered = (await x.repo.list({ month: '2026-10' })).find(
      (t) => t.description === 'Notebook',
    )!;
    expect(renumbered.installmentNumber).toBe(3);
    expect(
      x.mobile.sqlite
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(renumbered.id)?.object_id,
    ).toBe(slotBefore);
    const first = x.desktop.saveTransaction({
        kind: 'expense',
        description: 'Lote 1',
        plannedAmount: 1,
        dueDate: '2026-10-10',
        status: 'planned',
      }),
      second = x.desktop.saveTransaction({
        kind: 'expense',
        description: 'Lote 2',
        plannedAmount: 2,
        dueDate: '2026-10-10',
        status: 'planned',
      });
    await deliver(x.db, x.mb, x.a, 'android');
    x.desktop.settleTransactions([first.id, second.id]);
    const pending = await x.db.read(
      "SELECT payload_json FROM sync_outbox WHERE state='pending'",
    );
    expect(pending).toHaveLength(1);
    expect(JSON.parse(String(pending[0].payload_json)).operations).toHaveLength(
      2,
    );
    await deliver(x.db, x.mb, x.a, 'android');
    expect(
      (await x.repo.list({ month: '2026-10' }))
        .filter((t) => t.description.startsWith('Lote'))
        .every((t) => t.status === 'paid'),
    ).toBe(true);
  });
  it('merges disjoint edits, retains indivisible settlement conflicts and never resurrects delete/edit', async () => {
    const x = await banks();
    const tx = x.desktop.saveTransaction({
      kind: 'expense',
      description: 'Base',
      plannedAmount: 1,
      dueDate: '2026-10-10',
      status: 'planned',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const mobile = (await x.repo.list({ month: '2026-10' }))[0];
    x.desktop.saveTransaction({ ...tx, description: 'Descrição offline' });
    await x.repo.save({ ...mobile, notes: 'Nota offline' });
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(
      x.desktop.db
        .prepare('SELECT description,notes FROM transactions WHERE id=?')
        .get(tx.id),
    ).toMatchObject({
      description: 'Descrição offline',
      notes: 'Nota offline',
    });
    const d = x.desktop.listTransactions({ month: '2026-10' })[0],
      m = (await x.repo.list({ month: '2026-10' }))[0];
    x.desktop.saveTransaction({
      ...d,
      actualAmount: 1,
      status: 'paid',
      settledDate: '2026-10-10',
    });
    await x.repo.save({
      ...m,
      actualAmount: 2,
      status: 'paid',
      settledDate: '2026-10-11',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    const identity = x.desktop.db
      .prepare(
        "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
      )
      .get(tx.id)!;
    const heads = (
      await x.db.read(
        'SELECT revision_id FROM sync_heads WHERE object_id=? ORDER BY revision_id',
        [String(identity.object_id)],
      )
    ).map((h) => String(h.revision_id));
    expect(heads).toHaveLength(2);
    expect(
      x.desktop.db
        .prepare('SELECT status FROM transactions WHERE id=?')
        .get(tx.id)?.status,
    ).toBe('planned');
    const branch = JSON.parse(
      String(
        (
          await x.db.read(
            'SELECT payload_json FROM sync_revisions WHERE revision_id=?',
            [heads[0]],
          )
        )[0].payload_json,
      ),
    );
    await expect(
      x.db.run(
        resolveFinancial(
          String(identity.object_id),
          [heads[0]],
          branch,
          'desktop',
          randomUUID,
        ),
      ),
    ).rejects.toThrow('heads_changed');
    await x.db.run(
      resolveFinancial(
        String(identity.object_id),
        heads,
        branch,
        'desktop',
        randomUUID,
      ),
    );
    await deliver(x.db, x.mb, x.a, 'android');
    x.desktop.deleteTransaction(tx.id);
    await x.repo.save({
      ...(await x.repo.list({ month: '2026-10' }))[0],
      description: 'Edição antes de receber exclusão',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(x.desktop.listTransactions({ month: '2026-10' })).toHaveLength(0);
    expect(await x.repo.list({ month: '2026-10' })).toHaveLength(0);
    expect(
      x.desktop.db
        .prepare('SELECT * FROM sync_tombstones WHERE object_id=?')
        .all(identity.object_id),
    ).toHaveLength(1);
  });

  it('shares an anchor based on actual settlement and retains the original occurrence slot', async () => {
    const x = await banks();
    x.desktop.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Ancorada',
      plannedAmount: 1,
      startMonth: '2026-10',
      startDate: '2026-10-10',
      dueDay: 10,
      frequency: 'custom',
      intervalCount: 1,
      intervalUnit: 'months',
      anchorToActual: true,
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const initial = x.desktop
      .listTransactions({ month: '2026-10' })
      .find((t) => t.description === 'Ancorada')!;
    x.desktop.saveTransaction({
      ...initial,
      status: 'paid',
      actualAmount: 0,
      settledDate: '2026-10-20',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const a = x.desktop
        .listTransactions({ month: '2026-11' })
        .find((t) => t.description === 'Ancorada')!,
      b = (await x.repo.list({ month: '2026-11' })).find(
        (t) => t.description === 'Ancorada',
      )!;
    expect(a.dueDate).toBe('2026-11-20');
    expect(b.dueDate).toBe(a.dueDate);
    expect(
      x.desktop.db
        .prepare('SELECT original_date FROM sync_slots WHERE local_id=?')
        .get(initial.id)?.original_date,
    ).toBe('2026-10-10');
    expect(
      x.desktop.db
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(a.id)?.object_id,
    ).toBe(
      x.mobile.sqlite
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(b.id)?.object_id,
    );
  });

  it('converges priority aggregates and card-cycle slot identity', async () => {
    const x = await banks();
    x.desktop.createCatalogItem({
      type: 'card',
      name: 'Ciclo',
      dueDay: 10,
      closingDay: 3,
    });
    const card = x.desktop.getCatalogs().cards[0];
    x.desktop.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Assinatura no cartão',
      plannedAmount: 10,
      startMonth: '2026-10',
      dueDay: 10,
      chargeDay: 5,
      cardId: card.id,
    });
    const manual = x.desktop.saveTransaction({
      kind: 'expense',
      description: 'Prioridade manual',
      plannedAmount: 1,
      dueDate: '2026-11-10',
      status: 'planned',
    });
    await deliver(x.db, x.mb, x.a, 'android');
    const a = x.desktop
        .listTransactions({ month: '2026-11' })
        .find((t) => t.sourceType === 'recurring')!,
      b = (await x.repo.list({ month: '2026-11' })).find(
        (t) => t.sourceType === 'recurring',
      )!;
    expect(a.dueDate).toBe(b.dueDate);
    expect(a.purchaseDate).toBe(b.purchaseDate);
    expect(
      x.desktop.db
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(a.id)?.object_id,
    ).toBe(
      x.mobile.sqlite
        .prepare('SELECT object_id FROM sync_slots WHERE local_id=?')
        .get(b.id)?.object_id,
    );
    await deliver(x.db, x.mb, x.a, 'android');
    await deliver(x.mb, x.db, x.b, 'desktop');
    await deliver(x.db, x.mb, x.a, 'android');
    x.desktop.setTransactionPriority({
      month: '2026-11',
      transactionId: manual.id,
      pinned: true,
    });
    x.desktop.setTransactionPriority({
      month: '2026-11',
      transactionId: a.id,
      pinned: true,
    });
    await deliver(x.db, x.mb, x.a, 'android');
    expect(
      x.mobile.sqlite.prepare('SELECT * FROM transaction_priority_order').all(),
    ).toHaveLength(2);
    expect(
      x.mobile.sqlite
        .prepare('SELECT * FROM recurring_transaction_priorities')
        .all(),
    ).toHaveLength(1);
    const incoming = (await x.repo.list({ month: '2026-11' })).find(
      (t) => t.description === 'Prioridade manual',
    )!;
    await x.repo.setPriority({
      month: '2026-11',
      transactionId: incoming.id,
      pinned: false,
    });
    await deliver(x.mb, x.db, x.b, 'desktop');
    expect(
      x.desktop.db
        .prepare(
          'SELECT * FROM transaction_priority_order WHERE transaction_id=?',
        )
        .all(manual.id),
    ).toHaveLength(0);
  });
});
