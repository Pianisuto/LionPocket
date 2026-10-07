import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseBackupJson, desktopBackupData } from '@lionpocket/core';
import { startFinancialBaseline, syncTables, type ProvisionedProfile } from '@lionpocket/sync-local';
import { LionPocketDatabase } from './database';
import { sqliteTestConnection } from '../../../mobile/src/db/sqliteTestConnection';
import { migrate, migrations } from '../../../mobile/src/db/migrations';
import { MobileRepository } from '../../../mobile/src/db/repository';
import { mergeBackupData } from '../../../mobile/src/db/importRepository';
import { captureBackup, loadBackupData, restoreBackup, verifyDatabase } from '../../../mobile/src/db/backupRepository';

const close: (() => void)[] = [];
afterEach(() => close.splice(0).reverse().forEach(f => f()));
function bank(path = ':memory:') { const b = new LionPocketDatabase(path); close.push(() => b.db.close()); return b; }
async function mobile(path?: string) { const m = sqliteTestConnection(path); close.push(() => m.sqlite.close()); await migrate(m.db); return { ...m, repo: new MobileRepository(m.db, randomUUID) }; }

describe('monthly planning persistence and restoration', () => {
  it.each(['desktop', 'android'] as const)('creates, edits, clears and restores independent months on %s without financial side effects', async dialect => {
    const desktop = dialect === 'desktop' ? bank() : null;
    const android = dialect === 'android' ? await mobile() : null;
    const save = async (month: string, safetyMarginCents: number) => desktop ? desktop.saveMonthlyPlanning({ month, safetyMarginCents }) : android!.repo.saveMonthlyPlanning({ month, safetyMarginCents });
    const read = (month: string) => desktop ? desktop.getMonthlyPlanning(month) : android!.repo.getMonthlyPlanning(month);
    const overview = (month: string) => desktop ? desktop.getOverview(month) : android!.repo.monthlyOverview(month);
    const before = await overview('2026-10');
    expect(await read('2026-10')).toBeNull();
    await save('2026-10', 50000); await save('2026-11', 30000);
    await save('2026-10', 50123);
    expect(await read('2026-10')).toEqual({ month: '2026-10', safetyMarginCents: 50123 });
    expect(await read('2026-11')).toEqual({ month: '2026-11', safetyMarginCents: 30000 });
    expect(await read('2026-12')).toBeNull();
    const after = await overview('2026-10');
    expect(after.summary).toEqual(before.summary);
    expect(after.categoryBreakdown).toEqual(before.categoryBreakdown);
    expect(after.upcoming).toEqual(before.upcoming);
    expect(after.planning).toMatchObject({ projectedBalance: 0, safetyMargin: 501.23, balanceAfterSafetyMargin: -501.23 });
    for (const cents of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(save('2026-10', cents)).rejects.toThrow();
    }
    await expect(save('2026-13', 1)).rejects.toThrow();
    await save('2026-10', 0);
    expect((await overview('2026-10')).planning!.safetyMargin).toBe(0);
    await save('2026-10', 10000);
    expect(await read('2026-11')).toMatchObject({ safetyMarginCents: 30000 });
    const sqlite = desktop?.db ?? android!.sqlite;
    expect(sqlite.prepare('SELECT id,month,safety_margin_cents FROM monthly_planning ORDER BY month').all()).toMatchObject([
      { id: '2026-10', month: '2026-10', safety_margin_cents: 10000 }, { id: '2026-11', month: '2026-11', safety_margin_cents: 30000 },
    ]);
    expect(sqlite.prepare('SELECT * FROM transactions').all()).toEqual([]);
    expect(() => sqlite.exec("UPDATE monthly_planning SET safety_margin_cents=-1")).toThrow();
  });
  it('survives file reopen and a SQLite backup on Desktop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-monthly-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'bank.sqlite'), backup = join(dir, 'backup.sqlite');
    const first = new LionPocketDatabase(path);
    first.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    first.db.prepare('VACUUM INTO ?').run(backup); first.db.close();
    expect(bank(path).getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 50000 });
    expect(bank(backup).getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 50000 });
  });
  it('survives Android file reopen, verified JSON staging, backup restore and SQLite backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-monthly-mobile-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = sqliteTestConnection(join(dir, 'bank.sqlite')); await migrate(first.db);
    await new MobileRepository(first.db).saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 12345 });
    first.sqlite.prepare('VACUUM INTO ?').run(join(dir, 'backup.sqlite')); first.sqlite.close();
    const reopened = await mobile(join(dir, 'bank.sqlite'));
    expect(await reopened.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 12345 });
    expect(await (await mobile(join(dir, 'backup.sqlite'))).repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 12345 });
    const backup = await captureBackup(reopened.db);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const staged = await loadBackupData(stage.db, backup.data, backup.schemaVersion);
    const target = await mobile();
    await restoreBackup(target.db, staged, async () => { /* Disposable target; no personal database. */ });
    await verifyDatabase(target.db, staged.schemaVersion);
    expect(await target.repo.getMonthlyPlanning('2026-10')).toEqual({ month: '2026-10', safetyMarginCents: 12345 });
  });
  it('imports complete Desktop JSON into Android without losing cents or planning', async () => {
    const b = bank(); b.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50001 });
    const parsed = parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 15, data: b.exportData(true) }));
    expect(parsed.schemaVersion).toBe(10);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const staged = await loadBackupData(stage.db, desktopBackupData(parsed.data), parsed.schemaVersion);
    const target = await mobile(); await restoreBackup(target.db, staged, async () => { /* Disposable target; no personal database. */ });
    expect(await target.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 50001 });
  });
  it('adds absent months from complete JSON and refuses a conflicting month without overwriting local data', async () => {
    const b = bank(); b.saveMonthlyPlanning({ month: '2026-11', safetyMarginCents: 30000 });
    const parsed = parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 15, data: b.exportData(true) }));
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const incoming = await loadBackupData(stage.db, desktopBackupData(parsed.data), parsed.schemaVersion);
    const target = await mobile(); await target.repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    const before = await captureBackup(target.db);
    const merged = mergeBackupData(before.data, incoming.data);
    await restoreBackup(target.db, { ...before, data: merged.data }, async () => { /* Disposable fixture. */ });
    expect(await target.repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 50000 });
    expect(await target.repo.getMonthlyPlanning('2026-11')).toMatchObject({ safetyMarginCents: 30000 });
    b.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 10000 });
    const conflicting = desktopBackupData(parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 15, data: b.exportData(true) })).data);
    const current = await captureBackup(target.db);
    expect(() => mergeBackupData(current.data, conflicting)).toThrow('conflitam');
    expect(await captureBackup(target.db)).toEqual(expect.objectContaining({ data: current.data }));
  });
  it('rolls back a late Android v10 failure with the predecessor schema, sync queues and all records intact', async () => {
    const old = sqliteTestConnection(); close.push(() => old.sqlite.close());
    // Build the actual v9 schema, including its old identity CHECK, without replaying v10.
    for (const statements of migrations.slice(0, 9)) for (const sql of statements) await old.db.executeAsync(sql);
    old.sqlite.exec('PRAGMA user_version=9');
    const repo = new MobileRepository(old.db, randomUUID);
    await repo.enableSyntheticManualSyncPilot();
    await repo.save({ kind: 'expense', description: 'Fila anterior', plannedAmount: 12.34, dueDate: '2026-10-10', status: 'planned' });
    const snapshot = () => ({
      version: old.sqlite.prepare('PRAGMA user_version').get(),
      schema: old.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: Object.fromEntries(old.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => [String(r.name), old.sqlite.prepare(`SELECT * FROM ${r.name}`).all()])),
    });
    const before = snapshot();
    const original = old.db.transaction.bind(old.db);
    old.db.transaction = action => original(async tx => {
      const execute = tx.executeAsync.bind(tx);
      tx.executeAsync = (async (...args: Parameters<typeof tx.executeAsync>) => {
        const result = await execute(...args);
        if (args[0] === 'PRAGMA user_version = 10') throw new Error('late-v10');
        return result;
      }) as typeof tx.executeAsync;
      return action(tx);
    });
    await expect(migrate(old.db)).rejects.toThrow('late-v10');
    expect(snapshot()).toEqual(before);
    old.db.transaction = original;
    await migrate(old.db);
    for (const [table, rows] of Object.entries(before.rows)) expect(old.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    expect(await repo.getMonthlyPlanning('2026-10')).toBeNull();
    await repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 100 });
    expect(await repo.getMonthlyPlanning('2026-10')).toMatchObject({ safetyMarginCents: 100 });
  });
  it('upgrades an existing Desktop bank preserving financial rows and populated sync sidecars verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-monthly-upgrade-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'old.sqlite'); const old = new LionPocketDatabase(path);
    old.saveTransaction({ kind: 'expense', description: 'Anterior', plannedAmount: 12.34, dueDate: '2026-10-10', status: 'planned' });
    const profile = { formatVersion: 1, installationId: randomUUID(), deviceId: randomUUID(), signingPublicKey: '', boxPublicKey: '', pin: { serverId: randomUUID(), serverEpoch: randomUUID(), vaultId: randomUUID(), founderDeviceId: randomUUID(), authorityPublicKey: 'A'.repeat(43), keyVersion: 1 }, grants: [], checkpoint: { version: '1', sha256: 'A'.repeat(43) } } as ProvisionedProfile;
    await old.syncDatabase().run(startFinancialBaseline(profile, 'https://fixture.invalid', '/fixture/backup.sqlite', randomUUID));
    const before = Object.fromEntries([...syncTables, 'transactions'].map(t => [t, old.db.prepare(`SELECT * FROM ${t}`).all()]));
    // Remove only the additive v15 table/marker to rehearse a populated predecessor schema.
    old.db.exec('DROP TABLE monthly_planning; DELETE FROM migrations WHERE version=15'); old.db.close();
    const upgraded = bank(path);
    expect(upgraded.getMonthlyPlanning('2026-10')).toBeNull();
    for (const [t, rows] of Object.entries(before)) expect(upgraded.db.prepare(`SELECT * FROM ${t}`).all()).toEqual(rows);
    expect(upgraded.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 1 });
    expect(upgraded.db.prepare("SELECT * FROM sync_identity WHERE entity_type='monthlyPlanning'").all()).toHaveLength(1);
    const snapshot = new DatabaseSync(path, { readOnly: true }); snapshot.close();
  });
});
