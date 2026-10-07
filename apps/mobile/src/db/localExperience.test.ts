import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportTransactionsCsv,
  importTransactionsCsv,
  desktopBackupData,
  planFinancialSpreadsheet,
  XlsxWorkbook,
  XlsxWorksheet,
  type Transaction,
  type TransactionInput,
  type TransactionPriorityInput,
  type LocalBackup,
} from '@lionpocket/core';
import type { DatabaseSync } from 'node:sqlite';
import { MobileRepository } from './repository';
import { captureBackup, loadBackupData, restoreBackup, verifyDatabase } from './backupRepository';
import { applyImportPlan, csvImportPlan, mergeBackupData } from './importRepository';
import { migrate, migrations } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
const cleanups: Array<() => void> = [];
async function mobile() {
  const native = sqliteTestConnection();
  cleanups.push(() => native.sqlite.close());
  await migrate(native.db);
  return { ...native, repo: new MobileRepository(native.db) };
}
const input = (description: string, changes: Partial<TransactionInput> = {}): TransactionInput => ({
  kind: 'expense',
  description,
  plannedAmount: 100,
  dueDate: '2026-09-30',
  status: 'planned',
  ...changes,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const order = (items: Transaction[]) =>
  items
    .filter((t) => t.priorityPosition !== null)
    .sort((a, b) => Number(a.priorityPosition) - Number(b.priorityPosition))
    .map((t) => t.description);
describe('prioridades, histórico e painel em SQLite', () => {
  it('ordena transacionalmente sobre o mês completo e mantém prioridades ocultas', async () => {
    const { repo, sqlite } = await mobile();
    for (const name of ['A', 'B', 'C']) await repo.save(input(name));
    const items = (await repo.list({ month: '2026-09' })).sort((a, b) =>
      a.description.localeCompare(b.description),
    );
    for (const item of items)
      await repo.setPriority({ month: '2026-09', transactionId: item.id, pinned: true });
    await repo.setPriority({
      month: '2026-09',
      transactionId: items[2].id,
      pinned: true,
      beforeTransactionId: items[0].id,
    });
    expect(order(await repo.list({ month: '2026-09' }))).toEqual(['C', 'A', 'B']);
    expect((await repo.list({ month: '2026-09', search: 'B' }))[0].priorityPosition).toBe(2);
    await repo.setPriority({ month: '2026-09', transactionId: items[0].id, pinned: false });
    expect(order(await repo.list({ month: '2026-09' }))).toEqual(['C', 'B']);
    sqlite.exec(
      "CREATE TRIGGER fail_order BEFORE INSERT ON transaction_priority_order BEGIN SELECT RAISE(ABORT, 'fail'); END",
    );
    await expect(
      repo.setPriority({ month: '2026-09', transactionId: items[0].id, pinned: true }),
    ).rejects.toThrow('fail');
    expect(order(await repo.list({ month: '2026-09' }))).toEqual(['C', 'B']);
  });
  it('herda recorrências para o futuro, preserva meses passados e desfaz a série toda', async () => {
    const { repo } = await mobile();
    await repo.saveRecurring({
      kind: 'expense',
      active: true,
      description: 'Semanal',
      startMonth: '2026-08',
      startDate: '2026-08-01',
      frequency: 'weekly',
      dueDay: 1,
      plannedAmount: 10,
    });
    const month = await repo.list({ month: '2026-09' });
    await repo.setPriority({ month: '2026-09', transactionId: month[0].id, pinned: true });
    expect((await repo.list({ month: '2026-08' })).every((t) => t.priorityPosition === null)).toBe(
      true,
    );
    expect((await repo.list({ month: '2026-10' })).every((t) => t.priorityPosition !== null)).toBe(
      true,
    );
    await repo.setPriority({
      month: '2026-10',
      transactionId: (await repo.list({ month: '2026-10' }))[0].id,
      pinned: false,
    });
    expect((await repo.list({ month: '2026-09' })).every((t) => t.priorityPosition === null)).toBe(
      true,
    );
  });
  it('sugere dados do histórico com realizado zero sem incluir tombstones ou cancelados', async () => {
    const { repo } = await mobile();
    await repo.save(input('Café', { actualAmount: 0 }));
    await repo.save(input('Café', { dueDate: '2026-08-30' }));
    await repo.save(input('Café cancelado', { status: 'cancelled' }));
    await repo.save(input('Café excluído'));
    await repo.remove((await repo.list({ month: '2026-09', search: 'excluído' }))[0].id);
    expect(await repo.suggest('expense', 'Café')).toEqual([
      expect.objectContaining({ description: 'Café', amount: 0, uses: 2 }),
    ]);
  });
  it('gera o ano, atribui pagamento tardio uma vez e preserva filtros fora dos totais', async () => {
    const { repo } = await mobile();
    await repo.save(
      input('Pagamento tardio', {
        dueDate: '2026-08-10',
        settledDate: '2026-09-10',
        status: 'paid',
        actualAmount: 90,
      }),
    );
    await repo.save(
      input('Receita', {
        kind: 'income',
        dueDate: '2026-09-10',
        settledDate: '2026-09-10',
        status: 'received',
        plannedAmount: 300,
      }),
    );
    await repo.saveRecurring({
      kind: 'expense',
      active: true,
      description: 'Mensal',
      startMonth: '2026-10',
      dueDay: 1,
      plannedAmount: 10,
    });
    const annual = await repo.annual('2026');
    expect(annual).toHaveLength(12);
    expect(annual[7].summary.paidExpenses).toBe(0);
    expect(annual[8].summary.paidExpenses).toBe(90);
    expect(annual[8].summary.realizedBalance).toBe(210);
    expect(annual[9].summary.plannedExpenses).toBe(10);
    expect(annual[8].categories).toEqual([expect.objectContaining({ amount: 90 })]);
    await expect(repo.annual('foo')).rejects.toThrow();
  });
});
describe('backup e restauração com SQLite real', () => {
  it('preserva exatamente todas as tabelas incluindo prioridades, excluídos e realizado zero após reabrir', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-restore-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const native = sqliteTestConnection(join(directory, 'live.sqlite'));
    await migrate(native.db);
    const repo = new MobileRepository(native.db);
    await repo.save(input('Zero', { actualAmount: 0, status: 'paid', settledDate: '2026-09-29' }));
    await repo.saveRecurring({
      kind: 'expense',
      active: true,
      description: 'Recorrente',
      startMonth: '2026-09',
      dueDay: 30,
      plannedAmount: 12,
    });
    await repo.saveInstallment({
      description: 'Compra',
      installmentAmount: 20,
      totalInstallments: 3,
      currentInstallment: 2,
      currentDueDate: '2026-09-30',
    });
    await repo.saveGoal({
      name: 'Objetivo',
      targetAmount: 100,
      savedAmount: 25,
      priority: 'high',
      status: 'saving',
    });
    const items = await repo.list({ month: '2026-09' });
    await repo.setPriority({ month: '2026-09', transactionId: items[0].id, pinned: true });
    await repo.remove(items.find((t) => t.sourceType === 'recurring')!.id);
    const original = await captureBackup(native.db);
    const stage = sqliteTestConnection();
    const hydrated = await loadBackupData(stage.db, original.data, original.schemaVersion);
    stage.sqlite.close();
    await repo.save(input('Depois do backup'));
    let recovery: LocalBackup | undefined;
    await restoreBackup(native.db, hydrated, async () => {
      recovery = await captureBackup(native.db);
    });
    expect(recovery!.data.transactions).toHaveLength(original.data.transactions.length + 1);
    expect((await captureBackup(native.db)).data).toEqual(original.data);
    native.sqlite.close();
    const reopened = sqliteTestConnection(join(directory, 'live.sqlite'));
    cleanups.push(() => reopened.sqlite.close());
    await migrate(reopened.db);
    expect((await captureBackup(reopened.db)).data).toEqual(original.data);
    await verifyDatabase(reopened.db, migrations.length);
    expect(
      (await new MobileRepository(reopened.db).list({ month: '2026-09' })).some(
        (t) => t.description === 'Recorrente',
      ),
    ).toBe(false);
  });
  it.each([1, 2, 3, 4])(
    'restaura um banco v%i depois de migrar sua cópia, preservando as colunas antigas',
    async (version) => {
      const old = sqliteTestConnection();
      cleanups.push(() => old.sqlite.close());
      for (const migration of migrations.slice(0, version))
        for (const sql of migration) old.sqlite.exec(sql);
      old.sqlite.exec(
        `PRAGMA user_version=${version}; INSERT INTO transactions(id,kind,description,planned_amount_cents,actual_amount_cents,due_date,settled_date,status,notes) VALUES('old','expense','Legado',101,0,'2026-09-15','2026-09-29','paid','Preservar')`,
      );
      await verifyDatabase(old.db, version);
      const before = old.sqlite.prepare('SELECT * FROM transactions').get()!;
      await migrate(old.db);
      const backup = await captureBackup(old.db);
      const { db, sqlite } = await mobile();
      await restoreBackup(db, backup, async () => {});
      const after = sqlite.prepare('SELECT * FROM transactions WHERE id = ?').get('old')!;
      for (const [key, value] of Object.entries(before)) expect(after[key]).toEqual(value);
      expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: migrations.length,
      });
    },
  );
  it.each([1, 2, 3, 4])(
    'carrega JSON v%i em staging e aplica migrations antes de substituir',
    async (version) => {
      const old = sqliteTestConnection();
      cleanups.push(() => old.sqlite.close());
      for (const migration of migrations.slice(0, version))
        for (const sql of migration) old.sqlite.exec(sql);
      old.sqlite.exec(`PRAGMA user_version=${version}`);
      const snapshot = await captureBackup(old.db);
      const stage = sqliteTestConnection();
      cleanups.push(() => stage.sqlite.close());
      const result = await loadBackupData(stage.db, snapshot.data, version);
      expect(result.schemaVersion).toBe(migrations.length);
      await verifyDatabase(stage.db, migrations.length);
    },
  );
  it('recusa versão futura, esquema estrangeiro, triggers e referências inválidas', async () => {
    const { db, sqlite } = await mobile();
    await expect(verifyDatabase(db, 99)).rejects.toThrow('mais nova');
    sqlite.exec('CREATE TABLE stranger(id TEXT)');
    await expect(verifyDatabase(db, migrations.length)).rejects.toThrow('Estrutura');
    sqlite.exec('DROP TABLE stranger');
    sqlite.exec(
      'CREATE TRIGGER malicious AFTER INSERT ON goals BEGIN DELETE FROM transactions; END',
    );
    await expect(verifyDatabase(db, migrations.length)).rejects.toThrow('Estrutura');
    sqlite.exec('DROP TRIGGER malicious');
    sqlite.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO transaction_priority_order VALUES('2026-09','missing',0,'now','now'); PRAGMA foreign_keys=ON",
    );
    await expect(verifyDatabase(db, migrations.length)).rejects.toThrow('referências');
  });
  it('não altera dados quando salvar a recuperação falha e reverte falha tardia de restauração', async () => {
    const { db, sqlite, repo } = await mobile();
    await repo.save(input('Atual'));
    const current = await captureBackup(db);
    const other = await mobile();
    await other.repo.save(input('Outro'));
    const backup = await captureBackup(other.db);
    await expect(
      restoreBackup(db, backup, async () => {
        throw new Error('Sem espaço');
      }),
    ).rejects.toThrow('Sem espaço');
    expect((await captureBackup(db)).data).toEqual(current.data);
    sqlite.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'fail restore'); END",
    );
    await expect(restoreBackup(db, backup, async () => {})).rejects.toThrow('fail restore');
    expect((await captureBackup(db)).data).toEqual(current.data);
  });
  it('recusa JSON com tabela ausente, coluna injetada ou centavos inválidos', async () => {
    const current = await captureBackup((await mobile()).db);
    for (const mutation of [
      (b: LocalBackup) => {
        delete b.data.goals;
      },
      (b: LocalBackup) => {
        b.data.categories[0]['evil); DROP TABLE transactions; --'] = 'x';
      },
      (b: LocalBackup) => {
        b.data.transactions = [{ id: 'invalid', planned_amount_cents: 1.1 }];
      },
    ]) {
      const backup = structuredClone(current);
      mutation(backup);
      const stage = sqliteTestConnection();
      cleanups.push(() => stage.sqlite.close());
      await expect(loadBackupData(stage.db, backup.data, backup.schemaVersion)).rejects.toThrow();
    }
  });
});
describe('importações aditivas e compatibilidade desktop', () => {
  it('importa CSV sem alterar registros atuais, ignora repetidos mesmo após exclusão', async () => {
    const source = await mobile();
    await source.repo.save(
      input('CSV', {
        actualAmount: 0,
        status: 'paid',
        settledDate: '2026-09-30',
        notes: 'Uma\nnota',
      }),
    );
    const plan = csvImportPlan(
      importTransactionsCsv(
        exportTransactionsCsv(await source.repo.exportTransactions()),
        'teste.csv',
      ),
    );
    const { db, repo } = await mobile();
    await repo.save(input('Anterior'));
    const before = (await captureBackup(db)).data.transactions[0];
    expect(await applyImportPlan(db, plan)).toMatchObject({ transactions: 1 });
    expect((await captureBackup(db)).data.transactions.find((r) => r.id === before.id)).toEqual(
      before,
    );
    const imported = (await repo.list({ month: '2026-09', source: 'imported' }))[0];
    expect(imported.actualAmount).toBe(0);
    await repo.remove(imported.id);
    expect(await applyImportPlan(db, plan)).toMatchObject({ transactions: 0, skipped: 1 });
  });
  it('reverte toda a importação inválida, inclusive novos cadastros', async () => {
    const { db } = await mobile();
    const before = await captureBackup(db);
    const rows = [
      {
        input: input('Válido'),
        categoryName: 'Categoria nova',
        paymentMethodName: 'Método novo',
        cardName: '',
        sourceKey: 'one',
      },
      {
        input: input('Inválido', { plannedAmount: -1 }),
        categoryName: '',
        paymentMethodName: '',
        cardName: '',
        sourceKey: 'two',
      },
    ];
    await expect(applyImportPlan(db, csvImportPlan(rows))).rejects.toThrow();
    expect((await captureBackup(db)).data).toEqual(before.data);
  });
  it('reutiliza o layout XLSX Config/Fixas/Objetivos/meses e evita duplicar séries', async () => {
    const workbook = new XlsxWorkbook();
    const fixed = new XlsxWorksheet('Fixas');
    fixed.setCell(3, 2, 'Internet');
    fixed.setCell(3, 3, 'Serviços');
    fixed.setCell(3, 5, 99.9);
    fixed.setCell(3, 6, 10);
    workbook.addWorksheet(fixed);
    const goals = new XlsxWorksheet('Objetivos');
    goals.setCell(3, 1, 'Viagem');
    goals.setCell(3, 5, 1000);
    goals.setCell(3, 6, 100);
    workbook.addWorksheet(goals);
    const sheet = new XlsxWorksheet('Set');
    sheet.setCell(1, 1, 'Setembro 2026');
    sheet.setCell(32, 3, 'Mercado');
    sheet.setCell(32, 4, 'Alimentação');
    sheet.setCell(32, 6, 120);
    sheet.setCell(32, 2, 30);
    workbook.addWorksheet(sheet);
    const plan = planFinancialSpreadsheet(workbook, 'financeiro.xlsx', '2026-09');
    const { db, repo } = await mobile();
    expect(await applyImportPlan(db, plan)).toMatchObject({
      transactions: 1,
      recurring: 1,
      goals: 1,
    });
    expect((await repo.list({ month: '2026-09', source: 'imported' }))[0]).toMatchObject({
      description: 'Mercado',
      plannedAmount: 120,
    });
    expect(await applyImportPlan(db, plan)).toMatchObject({
      transactions: 0,
      recurring: 0,
      goals: 0,
      skipped: 3,
    });
  });
  it('importa o JSON completo exportado pelo desktop e preserva registros do mobile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-desktop-json-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const { LionPocketDatabase } = await import(
      fileURLToPath(new URL('../../../desktop/src/main/database.ts', import.meta.url).href)
    );
    const desktop = new LionPocketDatabase(join(directory, 'desktop.sqlite')) as {
      db: DatabaseSync;
      saveTransaction: (input: TransactionInput) => Transaction;
      exportData: () => Record<string, Record<string, string | number | null>[]>;
    };
    cleanups.push(() => desktop.db.close());
    desktop.saveTransaction(
      input('Desktop', { status: 'paid', settledDate: '2026-09-29', actualAmount: 0 }),
    );
    // Historical pre-v15 JSON has no monthly planning table.
    const converted = desktopBackupData(Object.fromEntries(Object.entries(desktop.exportData()).filter(([table]) => table !== 'monthly_planning')));
    const stage = sqliteTestConnection();
    cleanups.push(() => stage.sqlite.close());
    const validated = await loadBackupData(stage.db, converted, 4);
    const { db, repo } = await mobile();
    await repo.save(input('Mobile'));
    const before = await captureBackup(db);
    const merged = mergeBackupData(before.data, validated.data);
    const check = sqliteTestConnection();
    cleanups.push(() => check.sqlite.close());
    await loadBackupData(check.db, merged.data, migrations.length);
    await restoreBackup(db, { ...before, data: merged.data }, async () => {});
    expect(
      (await captureBackup(db)).data.transactions.find(
        (r) => r.id === before.data.transactions[0].id,
      ),
    ).toEqual(before.data.transactions[0]);
    expect((await repo.list({ month: '2026-09', search: 'Desktop' }))[0].actualAmount).toBe(0);
    expect(mergeBackupData(merged.data, validated.data).added).toBe(0);
    const conflict = structuredClone(validated.data);
    conflict.transactions[0].description = 'Conflito';
    expect(() => mergeBackupData(merged.data, conflict)).toThrow('conflitam');
  });
});

// Direct financial/ordering comparison, using both databases as independent adapters.
it('mantém filtros, prioridades recorrentes e o painel anual equivalentes ao desktop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lion-local-parity-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const { LionPocketDatabase } = await import(
    fileURLToPath(new URL('../../../desktop/src/main/database.ts', import.meta.url).href)
  );
  type Desktop = {
    db: DatabaseSync;
    saveTransaction(input: TransactionInput): Transaction;
    saveRecurringExpense(input: Parameters<MobileRepository['saveRecurring']>[0]): unknown;
    listTransactions(input: Parameters<MobileRepository['list']>[0]): Transaction[];
    setTransactionPriority(input: TransactionPriorityInput): void;
    getOverview(month: string): { annual: unknown[] };
  };
  const desktop: Desktop = new LionPocketDatabase(join(directory, 'desktop.sqlite'));
  cleanups.push(() => desktop.db.close());
  const { repo } = await mobile();
  for (const data of [
    input('Café'),
    input('Boleto', { plannedAmount: 200 }),
    input('Pago atrasado', {
      status: 'paid',
      settledDate: '2026-09-15',
      dueDate: '2026-08-15',
      actualAmount: 90,
    }),
  ]) {
    desktop.saveTransaction(data);
    await repo.save(data);
  }
  const series = {
    kind: 'expense' as const,
    active: true,
    description: 'Mensal',
    startMonth: '2026-09',
    dueDay: 30,
    plannedAmount: 40,
  };
  desktop.saveRecurringExpense(series);
  await repo.saveRecurring(series);
  for (const month of ['2026-09', '2026-10']) {
    for (const description of ['Café', 'Mensal']) {
      const d = desktop.listTransactions({ month }).find((t) => t.description === description),
        m = (await repo.list({ month })).find((t) => t.description === description);
      if (d && m) {
        desktop.setTransactionPriority({ month, transactionId: d.id, pinned: true });
        await repo.setPriority({ month, transactionId: m.id, pinned: true });
      }
    }
    expect(order(await repo.list({ month }))).toEqual(order(desktop.listTransactions({ month })));
    for (const search of ['cafe', '200', 'atrasado'])
      expect((await repo.list({ month, search })).map((t) => t.description)).toEqual(
        desktop.listTransactions({ month, search }).map((t) => t.description),
      );
  }
  expect((await repo.annual('2026')).map((r) => r.summary)).toEqual(
    desktop.getOverview('2026-09').annual,
  );
});
