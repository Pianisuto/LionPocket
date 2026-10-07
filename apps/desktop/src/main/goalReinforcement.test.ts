import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  desktopBackupData, goalReinforcementPlan, parseBackupJson, totalGoalReinforcementForMonth,
  type Goal, type GoalInput, type GoalMonthlyReinforcement, type GoalStatus,
} from '@lionpocket/core';
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

const goalInput = (name: string, extra: Partial<GoalInput> = {}): GoalInput => ({
  name, targetAmount: 3000, savedAmount: 250.5, priority: 'medium', status: 'saving', dueDate: '2027-03-10', ...extra,
});

/** One surface over both platforms so the same behavior is asserted on Desktop and Android. */
async function subject(dialect: 'desktop' | 'android') {
  if (dialect === 'desktop') {
    const b = bank();
    return {
      sqlite: b.db,
      goals: async () => b.listGoals(),
      saveGoal: async (input: GoalInput) => { await b.saveGoal(input); },
      removeGoal: async (id: string) => b.deleteGoal(id),
      list: async (month: string) => b.listGoalReinforcements(month),
      save: async (input: GoalMonthlyReinforcement) => b.saveGoalReinforcement(input),
      remove: async (goalId: string, month: string) => b.removeGoalReinforcement(goalId, month),
    };
  }
  const m = await mobile();
  return {
    sqlite: m.sqlite,
    goals: () => m.repo.listGoals(),
    saveGoal: (input: GoalInput) => m.repo.saveGoal(input),
    removeGoal: (id: string) => m.repo.removeGoal(id),
    list: (month: string) => m.repo.listGoalReinforcements(month),
    save: (input: GoalMonthlyReinforcement) => m.repo.saveGoalReinforcement(input),
    remove: (goalId: string, month: string) => m.repo.removeGoalReinforcement(goalId, month),
  };
}
const byName = (goals: Goal[], name: string) => goals.find(goal => goal.name === name)!;

describe.each(['desktop', 'android'] as const)('goal monthly reinforcement on %s', dialect => {
  it('creates, edits, removes and redefines independent months without financial side effects', async () => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Notebook'));
    const notebook = byName(await s.goals(), 'Notebook');
    const before = { saved: notebook.savedAmount, progress: notebook.progress, remaining: notebook.remainingAmount, suggestion: notebook.suggestedMonthlyAmount };
    expect(await s.list('2026-10')).toEqual([]);
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 50000 });
    await s.save({ goalId: notebook.id, month: '2026-11', amountCents: 70000 });
    expect(await s.list('2026-10')).toEqual([{ goalId: notebook.id, month: '2026-10', amountCents: 50000 }]);
    expect(await s.list('2026-11')).toEqual([{ goalId: notebook.id, month: '2026-11', amountCents: 70000 }]);
    expect(await s.list('2026-12')).toEqual([]);
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 50123 });
    expect((await s.list('2026-10'))[0].amountCents).toBe(50123);
    expect((await s.list('2026-11'))[0].amountCents).toBe(70000);
    await s.remove(notebook.id, '2026-10');
    expect(await s.list('2026-10')).toEqual([]);
    expect((await s.list('2026-11'))[0].amountCents).toBe(70000);
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 10000 });
    expect(await s.list('2026-10')).toEqual([{ goalId: notebook.id, month: '2026-10', amountCents: 10000 }]);
    // Zero through save is the same as remove.
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 0 });
    expect(await s.list('2026-10')).toEqual([]);
    // Planning is not a ledger entry and does not move the goal.
    const after = byName(await s.goals(), 'Notebook');
    expect({ saved: after.savedAmount, progress: after.progress, remaining: after.remainingAmount, suggestion: after.suggestedMonthlyAmount }).toEqual(before);
    expect(s.sqlite.prepare('SELECT * FROM transactions').all()).toEqual([]);
    expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM goal_monthly_reinforcements').get()).toEqual({ n: 2 });
  });

  it('never creates an empty record when removing something that was not defined', async () => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Viagem'));
    const goal = byName(await s.goals(), 'Viagem');
    await s.remove(goal.id, '2026-10');
    await s.save({ goalId: goal.id, month: '2026-10', amountCents: 0 });
    expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM goal_monthly_reinforcements').get()).toEqual({ n: 0 });
  });

  it('sums several goals in the same month and keeps the suggestion separate from the reinforcement', async () => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Notebook'));
    await s.saveGoal(goalInput('Viagem', { status: 'planned', priority: 'high' }));
    await s.saveGoal(goalInput('Reserva', { dueDate: null }));
    const goals = await s.goals();
    const notebook = byName(goals, 'Notebook'), trip = byName(goals, 'Viagem');
    expect(notebook.suggestedMonthlyAmount).not.toBeNull();
    // Loading goals and months never writes the automatic suggestion as a decision.
    expect(await s.list('2026-10')).toEqual([]);
    expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM goal_monthly_reinforcements').get()).toEqual({ n: 0 });
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 50000 });
    await s.save({ goalId: trip.id, month: '2026-10', amountCents: 12345 });
    await s.save({ goalId: trip.id, month: '2026-11', amountCents: 999 });
    expect(await s.list('2026-10')).toHaveLength(2);
    expect(totalGoalReinforcementForMonth(goals, await s.list('2026-10'), '2026-10')).toBe(62345);
    expect(totalGoalReinforcementForMonth(goals, await s.list('2026-11'), '2026-11')).toBe(999);
    expect(totalGoalReinforcementForMonth(goals, await s.list('2026-12'), '2026-12')).toBe(0);
  });

  it('validates months, cents and the goal, rolling back nothing partial', async () => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Notebook'));
    const goal = byName(await s.goals(), 'Notebook');
    for (const amountCents of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(s.save({ goalId: goal.id, month: '2026-10', amountCents })).rejects.toThrow();
    await expect(s.save({ goalId: goal.id, month: '2026-13', amountCents: 1 })).rejects.toThrow();
    await expect(s.save({ goalId: 'missing', month: '2026-10', amountCents: 1 })).rejects.toThrow('Objetivo não encontrado');
    expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM goal_monthly_reinforcements').get()).toEqual({ n: 0 });
    await s.save({ goalId: goal.id, month: '2026-10', amountCents: Number.MAX_SAFE_INTEGER });
    expect((await s.list('2026-10'))[0].amountCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => s.sqlite.exec('UPDATE goal_monthly_reinforcements SET amount_cents=-1')).toThrow();
    expect(() => s.sqlite.exec("UPDATE goal_monthly_reinforcements SET month='2026-13'")).toThrow();
    expect(() => s.sqlite.exec("INSERT INTO goal_monthly_reinforcements VALUES('x','no-goal','2026-10',1,'t','t',NULL)")).toThrow();
  });

  it.each([
    ['planned', true, true], ['saving', true, true], ['paused', false, false], ['completed', false, false], ['cancelled', false, false],
  ] as [GoalStatus, boolean, boolean][])('status %s: accepts new reinforcement=%s, counts=%s', async (status, accepts, counts) => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Meta', { status: 'saving' }));
    const goal = byName(await s.goals(), 'Meta');
    await s.save({ goalId: goal.id, month: '2026-10', amountCents: 40000 });
    // Changing status keeps the history instead of silently rewriting it.
    await s.saveGoal({ ...goalInput('Meta', { status }), id: goal.id });
    const current = byName(await s.goals(), 'Meta');
    const stored = await s.list('2026-10');
    expect(stored).toEqual([{ goalId: goal.id, month: '2026-10', amountCents: 40000 }]);
    const plan = goalReinforcementPlan([current], stored, '2026-10');
    expect(plan.totalCents).toBe(counts ? 40000 : 0);
    expect(plan.items[0]).toMatchObject({ counted: counts, editable: accepts, amountCents: 40000 });
    if (accepts) await s.save({ goalId: goal.id, month: '2026-11', amountCents: 100 });
    else {
      await expect(s.save({ goalId: goal.id, month: '2026-11', amountCents: 100 })).rejects.toThrow();
      await expect(s.save({ goalId: goal.id, month: '2026-10', amountCents: 50000 })).rejects.toThrow();
      expect(await s.list('2026-11')).toEqual([]);
    }
    // Removing is always possible, and history returns when a paused goal resumes.
    if (status === 'paused') {
      await s.saveGoal({ ...goalInput('Meta', { status: 'saving' }), id: goal.id });
      expect(totalGoalReinforcementForMonth([byName(await s.goals(), 'Meta')], await s.list('2026-10'), '2026-10')).toBe(40000);
      await s.saveGoal({ ...goalInput('Meta', { status: 'paused' }), id: goal.id });
    }
    await s.remove(goal.id, '2026-10');
    expect(await s.list('2026-10')).toEqual([]);
  });

  it('retires the planning with the goal: no orphan row and no phantom total', async () => {
    const s = await subject(dialect);
    await s.saveGoal(goalInput('Notebook'));
    await s.saveGoal(goalInput('Viagem'));
    const [notebook, trip] = [byName(await s.goals(), 'Notebook'), byName(await s.goals(), 'Viagem')];
    await s.save({ goalId: notebook.id, month: '2026-10', amountCents: 50000 });
    await s.save({ goalId: notebook.id, month: '2026-11', amountCents: 70000 });
    await s.save({ goalId: trip.id, month: '2026-10', amountCents: 1000 });
    await s.removeGoal(notebook.id);
    expect(await s.list('2026-10')).toEqual([{ goalId: trip.id, month: '2026-10', amountCents: 1000 }]);
    expect(await s.list('2026-11')).toEqual([]);
    expect(totalGoalReinforcementForMonth(await s.goals(), await s.list('2026-10'), '2026-10')).toBe(1000);
    expect(s.sqlite.prepare('SELECT COUNT(*) AS n FROM goal_monthly_reinforcements WHERE goal_id=? AND deleted_at IS NULL').get(notebook.id)).toEqual({ n: 0 });
    await expect(s.save({ goalId: notebook.id, month: '2026-12', amountCents: 1 })).rejects.toThrow('Objetivo não encontrado');
    expect(s.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('goal reinforcement persistence, backup and conversion', () => {
  const seed = (b: LionPocketDatabase) => {
    const notebook = b.saveGoal(goalInput('Notebook')), trip = b.saveGoal(goalInput('Viagem', { status: 'planned' }));
    b.saveGoalReinforcement({ goalId: notebook.id, month: '2026-10', amountCents: 50001 });
    b.saveGoalReinforcement({ goalId: notebook.id, month: '2026-11', amountCents: 70000 });
    b.saveGoalReinforcement({ goalId: trip.id, month: '2026-10', amountCents: 12345 });
    return { notebook, trip };
  };
  it('survives Desktop file reopen and SQLite backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-goals-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'bank.sqlite'), backup = join(dir, 'backup.sqlite');
    const first = new LionPocketDatabase(path); const { notebook } = seed(first);
    first.db.prepare('VACUUM INTO ?').run(backup); first.db.close();
    for (const file of [path, backup]) {
      const reopened = bank(file);
      expect(reopened.listGoalReinforcements('2026-10')).toHaveLength(2);
      expect(reopened.listGoalReinforcements('2026-11')).toEqual([{ goalId: notebook.id, month: '2026-11', amountCents: 70000 }]);
    }
  });
  it('survives Android reopen, SQLite backup, verified JSON staging and restore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-goals-mobile-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = sqliteTestConnection(join(dir, 'bank.sqlite')); await migrate(first.db);
    const repo = new MobileRepository(first.db, randomUUID);
    await repo.saveGoal(goalInput('Notebook'));
    const goal = (await repo.listGoals())[0];
    await repo.saveGoalReinforcement({ goalId: goal.id, month: '2026-10', amountCents: 12345 });
    first.sqlite.prepare('VACUUM INTO ?').run(join(dir, 'backup.sqlite')); first.sqlite.close();
    const reopened = await mobile(join(dir, 'bank.sqlite'));
    expect(await reopened.repo.listGoalReinforcements('2026-10')).toEqual([{ goalId: goal.id, month: '2026-10', amountCents: 12345 }]);
    expect(await (await mobile(join(dir, 'backup.sqlite'))).repo.listGoalReinforcements('2026-10')).toHaveLength(1);
    const backup = await captureBackup(reopened.db);
    expect(backup.schemaVersion).toBe(11);
    expect(backup.data.goal_monthly_reinforcements).toHaveLength(1);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const staged = await loadBackupData(stage.db, backup.data, backup.schemaVersion);
    const target = await mobile();
    await restoreBackup(target.db, staged, async () => { /* Disposable target; no personal database. */ });
    await verifyDatabase(target.db, staged.schemaVersion);
    expect(await target.repo.listGoalReinforcements('2026-10')).toEqual([{ goalId: goal.id, month: '2026-10', amountCents: 12345 }]);
    // A restored copy rejects a reinforcement that points at no goal.
    const corrupt = { ...backup, data: { ...backup.data, goals: [] } };
    await expect(restoreBackup(target.db, corrupt, async () => { /* Disposable. */ })).rejects.toThrow();
  });
  it('exports the table in the complete Desktop JSON and converts it for Android, keeping exact cents', async () => {
    const b = bank(); const { notebook, trip } = seed(b);
    const exported = b.exportData(true);
    expect(exported.goal_monthly_reinforcements).toHaveLength(3);
    const parsed = parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 16, data: exported }));
    expect(parsed.schemaVersion).toBe(11);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const staged = await loadBackupData(stage.db, desktopBackupData(parsed.data), parsed.schemaVersion);
    const target = await mobile(); await restoreBackup(target.db, staged, async () => { /* Disposable target; no personal database. */ });
    expect(await target.repo.listGoalReinforcements('2026-10')).toEqual(expect.arrayContaining([
      { goalId: notebook.id, month: '2026-10', amountCents: 50001 }, { goalId: trip.id, month: '2026-10', amountCents: 12345 },
    ]));
    expect(await target.repo.listGoalReinforcements('2026-11')).toEqual([{ goalId: notebook.id, month: '2026-11', amountCents: 70000 }]);
  });
  it('still imports an earlier Desktop JSON (schema 15, no reinforcement table) into an empty planning table', async () => {
    const b = bank(); b.saveGoal(goalInput('Notebook'));
    const { goal_monthly_reinforcements: _ignored, ...legacy } = b.exportData(true);
    void _ignored;
    const parsed = parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 15, data: legacy }));
    expect(parsed.schemaVersion).toBe(10);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const staged = await loadBackupData(stage.db, desktopBackupData(parsed.data), parsed.schemaVersion);
    expect(staged.schemaVersion).toBe(11);
    expect(staged.data.goal_monthly_reinforcements).toEqual([]);
    expect(staged.data.goals).toHaveLength(1);
  });
  it('adds absent planning from JSON and refuses a conflicting goal month without overwriting local data', async () => {
    const b = bank(); const { notebook } = seed(b);
    const asBackup = () => desktopBackupData(parseBackupJson(JSON.stringify({ version: 1, schemaVersion: 16, data: b.exportData(true) })).data);
    const stage = sqliteTestConnection(); close.push(() => stage.sqlite.close());
    const incoming = await loadBackupData(stage.db, asBackup(), 11);
    const target = await mobile();
    const before = await captureBackup(target.db);
    const merged = mergeBackupData(before.data, incoming.data);
    await restoreBackup(target.db, { ...before, data: merged.data }, async () => { /* Disposable fixture. */ });
    expect(await target.repo.listGoalReinforcements('2026-10')).toHaveLength(2);
    // The same exact import is idempotent; a different amount for the same goal/month aborts.
    const again = await captureBackup(target.db);
    expect(mergeBackupData(again.data, incoming.data).added).toBe(0);
    b.saveGoalReinforcement({ goalId: notebook.id, month: '2026-10', amountCents: 1 });
    const stage2 = sqliteTestConnection(); close.push(() => stage2.sqlite.close());
    const conflicting = await loadBackupData(stage2.db, asBackup(), 11);
    const current = await captureBackup(target.db);
    expect(() => mergeBackupData(current.data, conflicting.data)).toThrow('conflitam');
    expect(await captureBackup(target.db)).toEqual(expect.objectContaining({ data: current.data }));
  });
});

describe('goal reinforcement schema upgrade', () => {
  const profile = () => ({ formatVersion: 1, installationId: randomUUID(), deviceId: randomUUID(), signingPublicKey: '', boxPublicKey: '', pin: { serverId: randomUUID(), serverEpoch: randomUUID(), vaultId: randomUUID(), founderDeviceId: randomUUID(), authorityPublicKey: 'A'.repeat(43), keyVersion: 1 }, grants: [], checkpoint: { version: '1', sha256: 'A'.repeat(43) } } as ProvisionedProfile);
  it('upgrades the real Desktop v15 predecessor, preserving every row and populated sync sidecar verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lion-goals-upgrade-')); close.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'v15.sqlite'); const old = new LionPocketDatabase(path);
    const goal = old.saveGoal(goalInput('Notebook'));
    old.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    old.saveTransaction({ kind: 'expense', description: 'Anterior', plannedAmount: 12.34, dueDate: '2026-10-10', status: 'planned' });
    await old.syncDatabase().run(startFinancialBaseline(profile(), 'https://fixture.invalid', '/fixture/backup.sqlite', randomUUID));
    const before = Object.fromEntries([...syncTables, 'transactions', 'goals', 'monthly_planning'].map(t => [t, old.db.prepare(`SELECT * FROM ${t}`).all()]));
    for (const table of ['sync_identity', 'sync_revisions', 'sync_heads', 'sync_outbox', 'sync_bindings', 'goals', 'monthly_planning'])
      expect(before[table].length).toBeGreaterThan(0);
    expect(before.sync_identity.map(r => r.entity_type)).toEqual(expect.arrayContaining(['goal', 'monthlyPlanning']));
    // Freeze the exact v15 sidecar definition (CHECK knows monthlyPlanning, not goal reinforcements).
    old.db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE sync_identity_v15 (
        entity_type TEXT NOT NULL CHECK(entity_type IN ('manualTransaction','transaction','category','paymentMethod','card','recurring','installmentPurchase','goal','recurringPriorityList','monthlyPriorityList','monthlyPlanning')),
        local_id TEXT NOT NULL, object_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY(entity_type,local_id));
      INSERT INTO sync_identity_v15 SELECT * FROM sync_identity;
      DROP TABLE sync_identity;
      ALTER TABLE sync_identity_v15 RENAME TO sync_identity;
      DROP TABLE goal_monthly_reinforcements;
      DELETE FROM migrations WHERE version=16;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    expect(old.db.prepare('SELECT MAX(version) AS version FROM migrations').get()).toMatchObject({ version: 15 });
    expect(() => old.db.prepare("INSERT INTO sync_identity VALUES('goalMonthlyReinforcement',?,?)").run('x', randomUUID())).toThrow(/CHECK constraint failed/);
    for (const [t, rows] of Object.entries(before)) expect(old.db.prepare(`SELECT * FROM ${t}`).all()).toEqual(rows);
    old.db.close();
    const upgraded = bank(path);
    expect(upgraded.db.prepare('SELECT MAX(version) AS version FROM migrations').get()).toMatchObject({ version: 16 });
    expect(upgraded.listGoalReinforcements('2026-10')).toEqual([]);
    for (const [t, rows] of Object.entries(before)) expect(upgraded.db.prepare(`SELECT * FROM ${t}`).all()).toEqual(rows);
    expect(upgraded.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // The identity CHECK now accepts the new type and capture triggers are installed.
    upgraded.saveGoalReinforcement({ goalId: goal.id, month: '2026-10', amountCents: 1 });
    expect(upgraded.db.prepare("SELECT * FROM sync_identity WHERE entity_type='goalMonthlyReinforcement'").all()).toHaveLength(1);
    expect(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_capture_goal_monthly_reinforcements_%'").all()).toHaveLength(3);
  });
  it('upgrades the real Android v10 predecessor preserving rows and sidecars, and rolls back a late failure', async () => {
    const old = sqliteTestConnection(); close.push(() => old.sqlite.close());
    for (const statements of migrations.slice(0, 10)) for (const sql of statements) await old.db.executeAsync(sql);
    old.sqlite.exec('PRAGMA user_version=10');
    const repo = new MobileRepository(old.db, randomUUID);
    await repo.enableSyntheticManualSyncPilot();
    await repo.saveGoal(goalInput('Notebook'));
    await repo.saveMonthlyPlanning({ month: '2026-10', safetyMarginCents: 50000 });
    await repo.save({ kind: 'expense', description: 'Fila anterior', plannedAmount: 12.34, dueDate: '2026-10-10', status: 'planned' });
    const snapshot = () => ({
      version: old.sqlite.prepare('PRAGMA user_version').get(),
      schema: old.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: Object.fromEntries(old.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => [String(r.name), old.sqlite.prepare(`SELECT * FROM ${r.name}`).all()])),
    });
    const before = snapshot();
    expect(before.version).toEqual({ user_version: 10 });
    for (const table of ['sync_identity', 'sync_revisions', 'sync_outbox', 'goals', 'monthly_planning'])
      expect(before.rows[table].length).toBeGreaterThan(0);
    const original = old.db.transaction.bind(old.db);
    old.db.transaction = action => original(async tx => {
      const execute = tx.executeAsync.bind(tx);
      tx.executeAsync = (async (...args: Parameters<typeof tx.executeAsync>) => {
        const result = await execute(...args);
        if (args[0] === 'PRAGMA user_version = 11') throw new Error('late-v11');
        return result;
      }) as typeof tx.executeAsync;
      return action(tx);
    });
    await expect(migrate(old.db)).rejects.toThrow('late-v11');
    expect(snapshot()).toEqual(before);
    old.db.transaction = original;
    await migrate(old.db);
    expect(old.sqlite.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
    for (const [table, rows] of Object.entries(before.rows)) expect(old.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    const goal = (await repo.listGoals())[0];
    expect(await repo.listGoalReinforcements('2026-10')).toEqual([]);
    await repo.saveGoalReinforcement({ goalId: goal.id, month: '2026-10', amountCents: 100 });
    expect(await repo.listGoalReinforcements('2026-10')).toEqual([{ goalId: goal.id, month: '2026-10', amountCents: 100 }]);
    expect(old.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
