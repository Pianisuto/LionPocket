import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  startFinancialBaseline,
  reconnectFinancial,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
function profile(): ProvisionedProfile {
  return {
    formatVersion: 1,
    installationId: randomUUID(),
    deviceId: randomUUID(),
    signingPublicKey: '',
    boxPublicKey: '',
    pin: {
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
async function activate(bank: LionPocketDatabase) {
  await bank
    .syncDatabase()
    .run(
      startFinancialBaseline(
        profile(),
        'https://sync-beta.lionslab.dev',
        '/private/test-backup.sqlite',
        randomUUID,
      ),
    );
}
describe('financial writers', () => {
  it('captures populated baselines without changing local IDs and records linked zero settlement atomically', async () => {
    const bank = new LionPocketDatabase(':memory:');
    bank.saveTransaction({
      kind: 'expense',
      description: 'prévia 🦁',
      plannedAmount: 0,
      dueDate: '2026-10-01',
      status: 'planned',
    });
    const initial = bank.db.prepare('SELECT id FROM transactions').get()?.id;
    await activate(bank);
    expect(bank.db.prepare('SELECT id FROM transactions').get()?.id).toBe(
      initial,
    );
    const category = bank.db.prepare('SELECT id FROM categories LIMIT 1').get()
      ?.id as string;
    const tx = bank.saveTransaction({
      kind: 'expense',
      description: 'Unicode 🦁',
      plannedAmount: 12.34,
      actualAmount: 0,
      dueDate: '2026-10-01',
      settledDate: '2026-10-01',
      status: 'paid',
      categoryId: category,
    });
    const revision = JSON.parse(
      String(
        bank.db
          .prepare(
            'SELECT payload_json FROM sync_revisions ORDER BY length(local_seq) DESC,local_seq DESC LIMIT 1',
          )
          .get()?.payload_json,
      ),
    );
    expect(revision.snapshot.actualAmountCents).toBe(0);
    expect(revision.snapshot.plannedAmountCents).toBe(1234);
    expect(revision.dependencies).toHaveLength(1);
    const before = bank.db
      .prepare('SELECT COUNT(*) AS n FROM sync_outbox')
      .get()?.n;
    bank.db.exec(
      "CREATE TRIGGER fail_financial BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'disk-full'); END",
    );
    expect(() =>
      bank.saveTransaction({
        id: tx.id,
        kind: 'expense',
        description: 'lost',
        plannedAmount: 1,
        dueDate: '2026-10-01',
        status: 'planned',
      }),
    ).toThrow('disk-full');
    expect(
      bank.db
        .prepare('SELECT description FROM transactions WHERE id=?')
        .get(tx.id)?.description,
    ).toBe('Unicode 🦁');
    expect(
      bank.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()?.n,
    ).toBe(before);
    expect(bank.db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    bank.db.close();
  });
  it('captures catalogs, goals and deletes with durable tombstones', async () => {
    const bank = new LionPocketDatabase(':memory:');
    await activate(bank);
    bank.createCatalogItem({ type: 'category', name: 'Beta', kind: 'expense' });
    const id = String(
      bank.db.prepare("SELECT id FROM categories WHERE name='Beta'").get()?.id,
    );
    const identity = bank.db
      .prepare(
        "SELECT object_id FROM sync_identity WHERE entity_type='category' AND local_id=?",
      )
      .get(id);
    expect(identity).toBeTruthy();
    bank.deleteCatalogItem('category', id);
    expect(
      bank.db
        .prepare('SELECT * FROM sync_tombstones WHERE object_id=?')
        .all(String(identity?.object_id)),
    ).toHaveLength(1);
    bank.saveGoal({
      name: 'Meta',
      itemModel: '',
      link: '',
      targetAmount: 0,
      savedAmount: 0,
      priority: 'high',
      status: 'planned',
    });
    expect(
      bank.db
        .prepare("SELECT * FROM sync_identity WHERE entity_type='goal'")
        .all(),
    ).toHaveLength(1);
    bank.db.close();
  });
  it('adopts edited legacy dates without changing financial rows or asking for historic slots', async () => {
    const bank = new LionPocketDatabase(':memory:');
    bank.saveRecurringExpense({ kind: 'expense', active: true, description: 'Legada', plannedAmount: 10, startMonth: '2026-10', dueDay: 10 });
    bank.listTransactions({ month: '2026-10' });
    const tx = bank.db.prepare("SELECT * FROM transactions WHERE description='Legada'").get()!;
    bank.db.prepare("UPDATE transactions SET due_date='2026-11-03' WHERE id=?").run(tx.id);
    const before = bank.db.prepare('SELECT * FROM transactions').all();
    await activate(bank);
    expect(bank.db.prepare('SELECT * FROM transactions').all()).toEqual(before);
    expect(bank.db.prepare('SELECT * FROM sync_review').all()).toEqual([]);
    const slot = bank.db.prepare('SELECT * FROM sync_slots WHERE local_id=?').get(tx.id)!;
    expect(slot.slot_key).toBe(`legacy:${slot.object_id}`);
    expect(bank.db.prepare('SELECT identity_status FROM sync_series').get()?.identity_status).toBe('resolved');
    expect(bank.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    bank.db.close();
  });
  it('reviews restored physical removals and captures cleared priority lists without silent tombstones', async () => {
    const bank = new LionPocketDatabase(':memory:'),
      p = profile();
    const tx = bank.saveTransaction({
      kind: 'expense',
      description: 'Removida na cópia',
      plannedAmount: 0,
      dueDate: '2026-10-10',
      status: 'planned',
    });
    bank.setTransactionPriority({
      month: '2026-10',
      transactionId: tx.id,
      pinned: true,
    });
    await bank
      .syncDatabase()
      .run(
        startFinancialBaseline(
          p,
          'https://fixture.invalid',
          '/private/before.sqlite',
          randomUUID,
        ),
      );
    const objectId = bank.db
      .prepare(
        "SELECT object_id FROM sync_identity WHERE entity_type='transaction' AND local_id=?",
      )
      .get(tx.id)!.object_id;
    bank.db.exec(
      "UPDATE sync_local_state SET mode='disabled'; DELETE FROM transaction_priority_order; DELETE FROM transactions;",
    );
    await bank
      .syncDatabase()
      .run(
        reconnectFinancial(
          p,
          'https://fixture.invalid',
          '/private/reconnect.sqlite',
          randomUUID,
        ),
      );
    expect(
      bank.db
        .prepare(
          "SELECT * FROM sync_review WHERE reason='restored_missing_record' AND object_id=?",
        )
        .all(objectId),
    ).toHaveLength(1);
    expect(
      bank.db
        .prepare('SELECT * FROM sync_tombstones WHERE object_id=?')
        .all(objectId),
    ).toHaveLength(0);
    const priority = bank.db
      .prepare(
        "SELECT r.payload_json FROM sync_heads h JOIN sync_revisions r USING(revision_id) JOIN sync_identity i USING(object_id) WHERE i.entity_type='monthlyPriorityList'",
      )
      .get()!;
    expect(
      JSON.parse(String(priority.payload_json)).snapshot.transactionIds,
    ).toEqual([]);
    expect(bank.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    bank.db.close();
  });
  it('keeps restored edits as new branches without a global combination gate', async () => {
    const bank = new LionPocketDatabase(':memory:'),
      p = profile();
    const tx = bank.saveTransaction({
      kind: 'expense',
      description: 'Antes',
      plannedAmount: 1,
      dueDate: '2026-10-10',
      status: 'planned',
    });
    await bank
      .syncDatabase()
      .run(
        startFinancialBaseline(
          p,
          'https://fixture.invalid',
          '/private/before.sqlite',
          randomUUID,
        ),
      );
    bank.db.exec("UPDATE sync_local_state SET mode='disabled'");
    bank.db
      .prepare("UPDATE transactions SET description='Após restore' WHERE id=?")
      .run(tx.id);
    const before = bank.db
      .prepare('SELECT count(*) AS n FROM sync_revisions')
      .get()?.n;
    await expect(
      bank
        .syncDatabase()
        .run(
          reconnectFinancial(
            { ...p, deviceId: randomUUID() },
            'https://fixture.invalid',
            '/private/reconnect.sqlite',
            randomUUID,
          ),
        ),
    ).rejects.toThrow('restore_binding_mismatch');
    await bank
      .syncDatabase()
      .run(
        reconnectFinancial(
          p,
          'https://fixture.invalid',
          '/private/reconnect.sqlite',
          randomUUID,
        ),
      );
    expect(
      bank.db.prepare('SELECT count(*) AS n FROM sync_revisions').get()?.n,
    ).toBe(Number(before) + 1);
    expect(
      bank.db.prepare('SELECT state FROM sync_bootstrap').get()?.state,
    ).toBe('captured');
    expect(
      bank.db
        .prepare('SELECT description FROM transactions WHERE id=?')
        .get(tx.id)?.description,
    ).toBe('Após restore');
    bank.db.close();
  });
});
