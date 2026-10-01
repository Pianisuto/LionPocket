import { fileURLToPath, URL } from 'node:url';
import { desktopBackupData, parseBackupJson } from '@lionpocket/core';
import { mergedDesktopBackup } from './importRepository';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteTestConnection } from './sqliteTestConnection';
import { migrate, migrations } from './migrations';
import { MobileRepository } from './repository';
import {
  captureBackup,
  loadBackupData,
  restoreBackup,
  verifyDatabase,
} from './backupRepository';
import { runManualChecks } from '../../../../tools/sync-stage1/manual-checks.cjs';
import { captureDatabaseManifest } from '../../../../tools/sync-stage0/database-manifest.cjs';
import { validateSyncBackup, foundationTables, foundationColumns } from '@lionpocket/sync-local';
const banks: ReturnType<typeof sqliteTestConnection>[] = [];
afterEach(() => banks.splice(0).forEach((b) => b.sqlite.close()));
async function empty() {
  const bank = sqliteTestConnection();
  banks.push(bank);
  await migrate(bank.db);
  return { ...bank, repo: new MobileRepository(bank.db, randomUUID) };
}
describe('manualTransaction synthetic Android adapter', () => {
  it('same app scenario and 12 SQL fault cases on its own empty bank', async () => {
    const { db, repo } = await empty();
    const result = await runManualChecks({
      read: async (sql, params) =>
        (
          await db.executeAsync<Record<string, string | number | null>>(
            sql,
            params,
          )
        ).rows._array,
      save: (i) => repo.save(i),
      settle: (id) => repo.settleMany([id]),
      remove: (id) => repo.remove(id),
      enable: () => repo.enableSyntheticManualSyncPilot(),
    });
    expect(result.faultCases).toBe(12);
    validateSyncBackup((await captureBackup(db)).data);
  });
  it('staging preserves lineage/history; restore preserves payloads and disables pilot', async () => {
    const bank = await empty();
    await bank.repo.enableSyntheticManualSyncPilot();
    await bank.repo.save({
      kind: 'income',
      description: 'História 🍋',
      plannedAmount: 0,
      actualAmount: 0,
      dueDate: '2026-09-30',
      status: 'received',
      settledDate: '2026-09-30',
    });
    const original = await captureBackup(bank.db),
      stage = sqliteTestConnection();
    banks.push(stage);
    const backup = await loadBackupData(
      stage.db,
      original.data,
      original.schemaVersion,
    );
    expect(backup.data).toEqual(original.data);
    await verifyDatabase(stage.db, migrations.length);
    const target = await empty();
    await restoreBackup(target.db, backup, async () => {});
    const restored = await captureBackup(target.db);
    expect(restored.data.sync_outbox).toEqual(original.data.sync_outbox);
    expect(restored.data.sync_revisions).toEqual(original.data.sync_revisions);
    expect(restored.data.sync_local_state[0]).toEqual({
      ...original.data.sync_local_state[0],
      mode: 'disabled',
    });
    validateSyncBackup(restored.data);
  });
  it('recognizes desktop v12 JSON in staging and refuses an implicit lineage merge', async () => {
    const desktopPath = fileURLToPath(
      new URL('../../../desktop/src/main/database.ts', import.meta.url),
    );
    const { LionPocketDatabase } = await import(/* @vite-ignore */ desktopPath);
    const desktop = new LionPocketDatabase(':memory:');
    try {
      desktop.enableSyntheticManualSyncPilot();
      desktop.saveTransaction({
        kind: 'expense',
        description: 'Intercâmbio sintético',
        plannedAmount: 0,
        actualAmount: 0,
        dueDate: '2026-09-30',
        status: 'planned',
      });
      const current = desktop.exportData(true);
      const source = { ...current };
      for (const table of Object.keys(source).filter(t => t.startsWith('sync_'))) {
        if (!foundationTables.includes(table)) delete source[table];
        else source[table] = source[table].map((row: Record<string,string|number|null>) => Object.fromEntries(foundationColumns[table].map(key => [key, row[key]])));
      }
      const parsed = parseBackupJson(
        JSON.stringify({ version: 1, schemaVersion: 12, data: source }),
      );
      expect(parsed.schemaVersion).toBe(6);
      const stage = sqliteTestConnection();
      banks.push(stage);
      const converted = await loadBackupData(
        stage.db,
        { ...desktopBackupData(parsed.data), local_preferences: [] },
        6,
      );
      expect(converted.data.sync_identity).toEqual(source.sync_identity);
      expect(converted.data.sync_revisions).toEqual(source.sync_revisions);
      expect(converted.data.sync_outbox.map(({receipt_json,...row})=>{void receipt_json;return row;})).toEqual(source.sync_outbox);
      const target = await empty(),
        before = await captureBackup(target.db);
      await expect(mergedDesktopBackup(target.db, converted)).rejects.toThrow(
        'onboarding',
      );
      expect((await captureBackup(target.db)).data).toEqual(before.data);
    } finally {
      desktop.db.close();
    }
  });
  it('rejects corruption before replacement and reverts a late restore fault', async () => {
    const bank = await empty();
    await bank.repo.enableSyntheticManualSyncPilot();
    await bank.repo.save({
      kind: 'expense',
      description: 'Preservar',
      plannedAmount: 0,
      dueDate: '2026-09-30',
      status: 'planned',
    });
    const backup = await captureBackup(bank.db),
      before = captureDatabaseManifest(bank.sqlite);
    const broken = structuredClone(backup);
    broken.data.sync_outbox[0].payload_json = '{}';
    await expect(
      restoreBackup(bank.db, broken, async () => {}),
    ).rejects.toThrow('mismatch');
    expect(captureDatabaseManifest(bank.sqlite)).toEqual(before);
    bank.sqlite.exec(
      "CREATE TEMP TRIGGER fail_restore AFTER INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'late restore'); END",
    );
    await expect(
      restoreBackup(bank.db, backup, async () => {}),
    ).rejects.toThrow('late restore');
    bank.sqlite.exec('DROP TRIGGER fail_restore');
    expect(captureDatabaseManifest(bank.sqlite)).toEqual(before);
  });
});
