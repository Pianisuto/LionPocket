import { afterEach, describe, expect, it } from 'vitest';
import { LionPocketDatabase } from '../database';
import { runManualChecks } from '../../../../../tools/sync-stage1/manual-checks.cjs';
import { captureDatabaseManifest } from '../../../../../tools/sync-stage0/database-manifest.cjs';
import { validateSyncBackup } from '@lionpocket/sync-local';
import type { BackupData } from '@lionpocket/core';
const banks: LionPocketDatabase[] = [];
afterEach(() => banks.splice(0).forEach((bank) => bank.db.close()));
function empty() {
  const bank = new LionPocketDatabase(':memory:');
  banks.push(bank);
  return bank;
}
describe('manualTransaction synthetic desktop', () => {
  it('create/edit/settle/delete and every injected SQL fault roll back both states', async () => {
    const bank = empty();
    const result = await runManualChecks({
      read: async (sql, params = []) =>
        bank.db.prepare(sql).all(...params) as Record<
          string,
          string | number | null
        >[],
      save: (input) => bank.saveTransaction(input),
      settle: (id) => bank.settleTransaction(id),
      remove: (id) => bank.deleteTransaction(id),
      enable: () => bank.enableSyntheticManualSyncPilot(),
    });
    expect(result.faultCases).toBe(12);
    validateSyncBackup(bank.exportData(true) as BackupData);
  });
  it('default disabled and enrollment rejects filled banks without changes', () => {
    const bank = empty();
    bank.saveTransaction({
      kind: 'expense',
      description: 'Local',
      plannedAmount: 0,
      dueDate: '2026-09-30',
      status: 'planned',
    });
    const before = captureDatabaseManifest(bank.db);
    expect(() => bank.enableSyntheticManualSyncPilot()).toThrow('empty');
    expect(captureDatabaseManifest(bank.db)).toEqual(before);
  });
  it('tracked objects cannot escape scope, and bulk settlement rolls back as a unit', () => {
    const bank = empty();
    bank.enableSyntheticManualSyncPilot();
    const input = {
      kind: 'expense' as const,
      description: 'Manual',
      plannedAmount: 0,
      dueDate: '2026-09-30',
      status: 'planned' as const,
    };
    const one = bank.saveTransaction(input),
      two = bank.saveTransaction(input);
    const category = bank.getCatalogs().categories[0];
    const before = captureDatabaseManifest(bank.db);
    expect(() =>
      bank.saveTransaction({ ...input, id: one.id, categoryId: category.id }),
    ).toThrow('scope');
    expect(captureDatabaseManifest(bank.db)).toEqual(before);
    bank.db.exec(
      "CREATE TEMP TRIGGER fail_bulk AFTER INSERT ON sync_outbox WHEN NEW.local_seq='4' BEGIN SELECT RAISE(ABORT,'fail bulk'); END",
    );
    expect(() => bank.settleTransactions([one.id, two.id])).toThrow(
      'fail bulk',
    );
    bank.db.exec('DROP TRIGGER fail_bulk');
    expect(captureDatabaseManifest(bank.db)).toEqual(before);
  });
});
