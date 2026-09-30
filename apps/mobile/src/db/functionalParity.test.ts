import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTables } from '@lionpocket/sync-local';
import { fileURLToPath } from 'node:url';
import { MobileRepository } from './repository';
import { migrate, migrations } from './migrations';
import {
  captureBackup,
  loadBackupData,
  restoreBackup,
  verifyDatabase,
} from './backupRepository';
import { sqliteTestConnection } from './sqliteTestConnection';
import {
  defaultPreferences,
  readPreferences,
  writePreferences,
} from './preferences';
import { seedNewCatalogs } from './catalogDefaults';
import {
  desktopBackupData,
  importTransactionsCsv,
  standardCategories,
  type TransactionInput,
  type Overview,
} from '@lionpocket/core';
import {
  applyImportPlan,
  csvImportPlan,
  mergedDesktopBackup,
} from './importRepository';
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup.splice(0).forEach((fn) => fn());
});
async function mobile(version = migrations.length) {
  const native = sqliteTestConnection();
  cleanup.push(() => native.sqlite.close());
  for (const migration of migrations.slice(0, version))
    for (const sql of migration) await native.db.executeAsync(sql);
  await native.db.executeAsync(`PRAGMA user_version = ${version}`);
  const repo = new MobileRepository(native.db);
  if (version < 6) {
    // Fixture construction emulates the historical app, which had no sync hook.
    const current = repo as unknown as { recordManualSync(tx: unknown, id: string): Promise<void> };
    vi.spyOn(current, 'recordManualSync').mockResolvedValue();
  }
  return { ...native, repo };
}
const input = (
  description: string,
  changes: Partial<TransactionInput> = {},
): TransactionInput => ({
  kind: 'expense',
  description,
  plannedAmount: 100,
  dueDate: '2026-09-30',
  status: 'planned',
  ...changes,
});
describe('paridade funcional e atualização protegida', () => {
  it('bancos novos recebem exatamente as categorias do desktop e bancos usados não são resemeados', async () => {
    const { db, repo } = await mobile();
    await seedNewCatalogs(db);
    expect(
      (await repo.catalogs()).categories
        .map((c) => [c.name, c.kind, c.color])
        .sort(),
    ).toEqual([...standardCategories].map((c) => [...c]).sort());
    await repo.save(input('Existente'));
    const before = await captureBackup(db);
    await expect(seedNewCatalogs(db)).rejects.toThrow('banco novo');
    expect((await captureBackup(db)).data).toEqual(before.data);
  });
  it('migra v4 para v5 sem alterar nenhum registro antigo, incluindo filhos e exclusões', async () => {
    const { db, repo, sqlite } = await mobile(4);
    await repo.save(
      input('Prioridade manual', { actualAmount: 0, notes: 'original' }),
    );
    await repo.save(input('Excluído'));
    const items = await repo.list({ month: '2026-09' });
    await repo.setPriority({
      month: '2026-09',
      transactionId: items.find((t) => t.description === 'Prioridade manual')!
        .id,
      pinned: true,
    });
    await repo.remove(items.find((t) => t.description === 'Excluído')!.id);
    await repo.saveRecurring({
      kind: 'income',
      description: 'Recorrência',
      active: true,
      startMonth: '2026-09',
      plannedAmount: 250,
      dueDay: 20,
    });
    await repo.saveInstallment({
      description: 'Compra',
      installmentAmount: 20,
      totalInstallments: 3,
      currentInstallment: 1,
      currentDueDate: '2026-09-30',
    });
    await repo.saveGoal({
      name: 'Objetivo',
      targetAmount: 50,
      savedAmount: 10,
      status: 'saving',
      priority: 'medium',
    });
    const recurrence = (await repo.list({ month: '2026-09' })).find(
      (t) => t.sourceType === 'recurring',
    )!;
    await repo.setPriority({
      month: '2026-09',
      transactionId: recurrence.id,
      pinned: true,
    });
    sqlite.exec(
      "INSERT INTO local_import_records VALUES('csv:previous', 'original')",
    );
    const before = await captureBackup(db);
    const protect = vi.fn(async () => {
      expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: 4,
      });
    });
    await migrate(db, protect);
    expect(protect).toHaveBeenCalledTimes(1);
    const after = await captureBackup(db);
    const { local_preferences, ...financial } = after.data;
    expect(Object.fromEntries(Object.entries(financial).filter(([table]) => !syncTables.includes(table)))).toEqual(before.data);
    expect(local_preferences).toEqual([]);
    await verifyDatabase(db, migrations.length);
    await migrate(db, protect);
    expect(protect).toHaveBeenCalledTimes(1);
    await repo.save(input('Valor zero', { plannedAmount: 0 }));
    expect(
      (await repo.list({ month: '2026-09', search: 'Valor zero' }))[0]
        .plannedAmount,
    ).toBe(0);
  });
  it('falha na proteção ou no rebuild mantém a versão e todos os dados intactos', async () => {
    const { db, repo } = await mobile(4);
    await repo.save(input('Preservar'));
    const before = await captureBackup(db);
    await expect(
      migrate(db, async () => {
        throw new Error('Sem espaço');
      }),
    ).rejects.toThrow('Sem espaço');
    expect(await captureBackup(db)).toEqual(before);
    const original = db.transaction.bind(db);
    const execute = vi.fn();
    db.transaction = (action) =>
      original(async (tx) => {
        const exec = tx.executeAsync.bind(tx);
        tx.executeAsync = async (...args) => {
          if (args[0].startsWith('CREATE TABLE goals')) {
            execute();
            throw new Error('Rebuild interrompido');
          }
          return exec(...args);
        };
        return action(tx);
      });
    await expect(migrate(db)).rejects.toThrow('Rebuild interrompido');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await captureBackup(db)).toEqual(before);
    await verifyDatabase(db, 4);
  });
  it('restaura v4 para v5 e faz round-trip de zero, preferências e prioridades', async () => {
    const old = await mobile(4);
    await old.repo.save(input('Original'));
    const backup = await captureBackup(old.db),
      stage = sqliteTestConnection();
    cleanup.push(() => stage.sqlite.close());
    const converted = await loadBackupData(stage.db, backup.data, 4);
    const current = await mobile();
    await restoreBackup(current.db, converted, async () => {});
    await current.repo.save(
      input('Zero', {
        plannedAmount: 0,
        status: 'paid',
        settledDate: '2026-09-29',
        actualAmount: 0,
      }),
    );
    await writePreferences(current.db, {
      theme: 'light',
      showPriorities: false,
      leoPets: 12,
      leoAccessory: 'crown',
    });
    const snapshot = await captureBackup(current.db),
      second = sqliteTestConnection();
    cleanup.push(() => second.sqlite.close());
    const restored = await loadBackupData(second.db, snapshot.data, migrations.length);
    expect(restored.data).toEqual(snapshot.data);
    await restoreBackup(current.db, restored, async () => {});
    expect(await readPreferences(current.db)).toEqual({
      theme: 'light',
      showPriorities: false,
      leoPets: 12,
      leoAccessory: 'crown',
    });
    await verifyDatabase(current.db, migrations.length);
  });
  it('preferências invalidas são ignoradas na leitura e rejeitadas atomicamente na gravação', async () => {
    const { db, sqlite } = await mobile();
    expect(await readPreferences(db)).toEqual(defaultPreferences);
    sqlite.exec(
      "INSERT INTO local_preferences VALUES('theme','unknown'),('leoPets','-20')",
    );
    expect(await readPreferences(db)).toEqual(defaultPreferences);
    await expect(
      writePreferences(db, { theme: 'light', leoPets: -1 }),
    ).rejects.toThrow('inválida');
    expect(await readPreferences(db)).toEqual(defaultPreferences);
  });
  it('completar categorias é aditivo, idempotente e preserva cores e vínculos', async () => {
    const { db, repo } = await mobile();
    await repo.createCatalog({
      id: 'cat-home',
      type: 'category',
      kind: 'expense',
      name: 'Moradia',
      color: '#123456',
    });
    await repo.save(input('Ligado', { categoryId: 'cat-home' }));
    const before = await captureBackup(db);
    await repo.completeStandardCategories();
    const after = await captureBackup(db);
    expect(after.data.transactions).toEqual(before.data.transactions);
    for (const row of before.data.categories)
      expect(after.data.categories).toContainEqual(row);
    const catalogs = await repo.catalogs();
    for (const [name, kind] of standardCategories)
      expect(
        catalogs.categories.some((c) => c.name === name && c.kind === kind),
      ).toBe(true);
    await repo.completeStandardCategories();
    expect((await captureBackup(db)).data).toEqual(after.data);
  });
  it('CSV com planejado zero entra sem conversão e a reimportação não duplica', async () => {
    const { db, repo } = await mobile();
    const csv =
      'data_compra,data,tipo,descricao,categoria,valor_planejado,valor_real,situacao,forma_pagamento,cartao,observacoes\n,2026-09-30,expense,Zero CSV,,0,,planned,,,teste';
    const plan = csvImportPlan(importTransactionsCsv(csv, 'zero.csv'));
    expect((await applyImportPlan(db, plan)).transactions).toBe(1);
    expect((await applyImportPlan(db, plan)).skipped).toBe(1);
    expect((await repo.list({ month: '2026-09' }))[0].plannedAmount).toBe(0);
  });
  it('compara valores zero, visão geral e JSON com o banco desktop sem mudar o desktop', async () => {
    const { LionPocketDatabase } = await import(
      fileURLToPath(
        new URL('../../../desktop/src/main/database.ts', import.meta.url).href,
      )
    );
    const desktop = new LionPocketDatabase(':memory:');
    cleanup.push(() => desktop.db.close());
    const { db, repo } = await mobile();
    for (const i of [
      input('Zero manual', { plannedAmount: 0 }),
      input('Pago', {
        status: 'paid',
        actualAmount: 50,
        settledDate: '2026-09-29',
      }),
      input('Renda', {
        kind: 'income',
        plannedAmount: 200,
        status: 'received',
        actualAmount: 180,
        settledDate: '2026-09-20',
      }),
    ]) {
      desktop.saveTransaction(i);
      await repo.save(i);
    }
    const recurrence = {
      kind: 'income' as const,
      active: true,
      description: 'Zero recorrente',
      startMonth: '2026-09',
      dueDay: 30,
      plannedAmount: 0,
    };
    desktop.saveRecurringExpense(recurrence);
    await repo.saveRecurring(recurrence);
    const purchase = {
      description: 'Parcelado',
      installmentAmount: 10,
      currentInstallment: 1,
      totalInstallments: 2,
      currentDueDate: '2026-09-30',
    };
    desktop.saveInstallmentPurchase(purchase);
    await repo.saveInstallment(purchase);
    expect(() =>
      desktop.saveInstallmentPurchase({ ...purchase, installmentAmount: 0 }),
    ).toThrow('maior que zero');
    await expect(
      repo.saveInstallment({ ...purchase, installmentAmount: 0 }),
    ).rejects.toThrow('maior que zero');
    const goal = {
      name: 'Zero alvo',
      targetAmount: 0,
      savedAmount: 0,
      status: 'saving' as const,
      priority: 'high' as const,
    };
    desktop.saveGoal(goal);
    await repo.saveGoal(goal);
    const expected: Overview = desktop.getOverview('2026-09'),
      actual = await repo.monthlyOverview('2026-09');
    expect(actual.summary).toEqual(expected.summary);
    expect(actual.categoryBreakdown).toEqual(expected.categoryBreakdown);
    expect(actual.upcoming.map((t) => t.description)).toEqual(
      expected.upcoming.map((t) => t.description),
    );
    expect(actual.recent.map((t) => t.description)).toEqual(
      expected.recent.map((t) => t.description),
    );
    expect(actual.goals.map((g) => ({ ...g, id: '' }))).toEqual(
      expected.goals.map((g) => ({ ...g, id: '' })),
    );
    const stage = sqliteTestConnection();
    cleanup.push(() => stage.sqlite.close());
    const imported = await loadBackupData(
      stage.db,
      { ...desktopBackupData(desktop.exportData()), local_preferences: [] },
      5,
    );
    await writePreferences(db, { theme: 'light' });
    const merged = await mergedDesktopBackup(db, imported);
    expect(merged.backup.data.local_preferences).toEqual([
      { key: 'theme', value: 'light' },
    ]);
    expect(
      merged.backup.data.transactions.some((r) => r.planned_amount_cents === 0),
    ).toBe(true);
  });
});
