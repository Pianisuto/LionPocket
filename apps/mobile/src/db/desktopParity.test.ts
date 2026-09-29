import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  InstallmentPurchaseInput,
  RecurringExpenseInput,
  Transaction,
} from '@lionpocket/core';
import { summarizeMonth } from '@lionpocket/core';
import type {
  CatalogInput,
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchase,
  Overview,
  TransactionFilters,
  TransactionInput,
} from '@lionpocket/core';
import type { DatabaseSync } from 'node:sqlite';
type Desktop = {
  db: DatabaseSync;
  getCatalogs(): Catalogs;
  createCatalogItem(input: CatalogInput): void;
  getOverview(month: string): Overview;
  listTransactions(filters: TransactionFilters): Transaction[];
  saveRecurringExpense(input: RecurringExpenseInput): RecurringExpenseInput & { id: string };
  deleteTransaction(id: string): void;
  settleTransaction(id: string): void;
  saveTransaction(input: TransactionInput): Transaction;
  saveInstallmentPurchase(input: InstallmentPurchaseInput): InstallmentPurchase;
  listInstallmentPurchases(month: string): InstallmentPurchase[];
  deleteInstallmentPurchase(id: string): void;
  saveGoal(input: GoalInput): Goal;
  listGoals(): Goal[];
};
import { MobileRepository } from './repository';
import { migrate } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup.splice(0).forEach((fn) => fn());
});
async function pair() {
  const directory = mkdtempSync(join(tmpdir(), 'lion-parity-'));
  // Dynamic test reference keeps Electron/Node types out of the mobile app build.
  const { LionPocketDatabase } = await import(
    fileURLToPath(new URL('../../../desktop/src/main/database.ts', import.meta.url).href)
  );
  const desktop: Desktop = new LionPocketDatabase(join(directory, 'desktop.sqlite'));
  const native = sqliteTestConnection();
  await migrate(native.db);
  const mobile = new MobileRepository(native.db);
  cleanup.push(() => {
    desktop.db.close();
    native.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { desktop, mobile };
}
const finances = (items: Transaction[]) =>
  items
    .map((t) => ({
      kind: t.kind,
      description: t.description,
      plannedAmount: t.plannedAmount,
      actualAmount: t.actualAmount,
      purchaseDate: t.purchaseDate,
      dueDate: t.dueDate,
      status: t.status,
      settledDate: t.settledDate,
      sourceType: t.sourceType,
      installmentNumber: t.installmentNumber,
      installmentTotal: t.installmentTotal,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
async function equalMonth(p: Awaited<ReturnType<typeof pair>>, month: string) {
  const desktop = p.desktop.listTransactions({ month }),
    mobile = await p.mobile.list({ month });
  expect(finances(mobile)).toEqual(finances(desktop));
  expect(summarizeMonth(mobile, month)).toEqual(p.desktop.getOverview(month).summary);
  return { desktop, mobile };
}
const recurrence = (input: Partial<RecurringExpenseInput> = {}): RecurringExpenseInput => ({
  kind: 'expense',
  active: true,
  description: 'Internet',
  startMonth: '2026-09',
  plannedAmount: 100,
  dueDay: 31,
  ...input,
});
describe('paridade financeira desktop/mobile com SQLite real', () => {
  it.each(['once', 'weekly', 'monthly', 'custom', 'manual'] as const)(
    'frequência %s, fronteiras e exclusão',
    async (frequency) => {
      const p = await pair();
      const input = recurrence({
        frequency,
        startDate: '2026-09-01',
        intervalCount: 2,
        intervalUnit: 'weeks',
        manualMonths: ['09', '12'],
      });
      p.desktop.saveRecurringExpense(input);
      await p.mobile.saveRecurring(input);
      for (const month of ['2026-08', '2026-09', '2026-10', '2026-12', '2027-01', '2027-09'])
        await equalMonth(p, month);
      const d = p.desktop
        .listTransactions({ month: '2026-09' })
        .find((t) => t.dueDate.startsWith('2026-09'))!;
      const m = (await p.mobile.list({ month: '2026-09' })).find((t) => t.dueDate === d.dueDate)!;
      p.desktop.deleteTransaction(d.id);
      await p.mobile.remove(m.id);
      await equalMonth(p, '2026-09');
    },
  );
  it.each([
    [20, 5, 19],
    [20, 5, 20],
    [20, 25, 20],
    [null, 10, 15],
    [31, 5, 31],
  ] as const)(
    'cartão fecha %s vence %s cobra %s, atualiza meses gerados sem duplicar',
    async (closingDay, dueDay, chargeDay) => {
      const p = await pair();
      p.desktop.createCatalogItem({ type: 'card', name: 'Cartão', closingDay, dueDay });
      await p.mobile.createCatalog({ type: 'card', name: 'Cartão', closingDay, dueDay });
      const dCard = p.desktop.getCatalogs().cards[0].id,
        mCard = (await p.mobile.catalogs()).cards[0].id;
      const input = recurrence({ chargeDay });
      const d = p.desktop.saveRecurringExpense({ ...input, cardId: dCard });
      await p.mobile.saveRecurring({ ...input, cardId: mCard });
      const [m] = await p.mobile.listRecurring();
      for (const month of ['2026-09', '2026-10', '2026-11', '2026-12']) await equalMonth(p, month);
      const dp = p.desktop
        .listTransactions({ month: '2026-11' })
        .find((t) => t.dueDate.startsWith('2026-11'))!;
      const mp = (await p.mobile.list({ month: '2026-11' })).find((t) => t.dueDate === dp.dueDate)!;
      p.desktop.settleTransaction(dp.id);
      await p.mobile.settle(mp.id);
      p.desktop.saveRecurringExpense({ ...d, plannedAmount: 155, chargeDay: 1 });
      await p.mobile.saveRecurring({ ...m, plannedAmount: 155, chargeDay: 1 });
      for (const month of ['2026-09', '2026-10', '2026-11', '2026-12']) await equalMonth(p, month);
    },
  );
  it('intervalo por data efetiva após realização; cartão ancora na compra', async () => {
    for (const card of [false, true]) {
      const p = await pair();
      let dCard: string | null = null,
        mCard: string | null = null;
      if (card) {
        p.desktop.createCatalogItem({ type: 'card', name: 'Cartão', closingDay: 20, dueDay: 25 });
        await p.mobile.createCatalog({ type: 'card', name: 'Cartão', closingDay: 20, dueDay: 25 });
        dCard = p.desktop.getCatalogs().cards[0].id;
        mCard = (await p.mobile.catalogs()).cards[0].id;
      }
      const input = recurrence({
        kind: card ? 'expense' : 'income',
        frequency: 'custom',
        anchorToActual: true,
        intervalUnit: 'days',
        intervalCount: 10,
        startDate: '2026-09-01',
      });
      p.desktop.saveRecurringExpense({ ...input, cardId: dCard });
      await p.mobile.saveRecurring({ ...input, cardId: mCard });
      const values = await equalMonth(p, '2026-09');
      const d = values.desktop.find((t) => (t.purchaseDate ?? t.dueDate) === '2026-09-01')!;
      const m = values.mobile.find(
        (t) => t.purchaseDate === d.purchaseDate && t.dueDate === d.dueDate,
      )!;
      p.desktop.saveTransaction({
        ...d,
        actualAmount: 98,
        settledDate: '2026-09-03',
        status: card ? 'paid' : 'received',
      });
      await p.mobile.save({
        ...m,
        actualAmount: 98,
        settledDate: '2026-09-03',
        status: card ? 'paid' : 'received',
      });
      await equalMonth(p, '2026-09');
      await equalMonth(p, '2026-10');
    }
  });
  it('parcela atual, renumeração, calendário, progresso, total e exclusão', async () => {
    const p = await pair();
    const input: InstallmentPurchaseInput = {
      description: 'Notebook',
      installmentAmount: 100,
      totalInstallments: 5,
      currentInstallment: 2,
      currentDueDate: '2026-09-30',
    };
    const d = p.desktop.saveInstallmentPurchase(input);
    await p.mobile.saveInstallment(input);
    const [m] = await p.mobile.listInstallments('2026-09');
    for (const month of ['2026-09', '2026-10', '2026-11', '2026-12']) await equalMonth(p, month);
    const tx = await equalMonth(p, '2026-09');
    p.desktop.settleTransaction(tx.desktop[0].id);
    await p.mobile.settle(tx.mobile[0].id);
    const changed = {
      ...input,
      currentInstallment: 4,
      originalCurrentInstallment: 3,
      totalInstallments: 7,
      installmentAmount: 125,
      currentDueDate: '2026-10-31',
    };
    p.desktop.saveInstallmentPurchase({ ...changed, id: d.id });
    await p.mobile.saveInstallment({ ...changed, id: m.id });
    for (const month of ['2026-09', '2026-10', '2026-11', '2027-01']) {
      await equalMonth(p, month);
      const dg = p.desktop.listInstallmentPurchases(month)[0],
        mg = (await p.mobile.listInstallments(month))[0];
      expect(mg.paidInstallments).toBe(dg.paidInstallments);
      expect(mg.viewedInstallment).toBe(dg.viewedInstallment);
    }
    p.desktop.deleteInstallmentPurchase(d.id);
    await p.mobile.removeInstallment(m.id);
    await equalMonth(p, '2026-09');
    await equalMonth(p, '2026-10');
  });
  it('objetivos: progresso, prioridade, prazo, situação e edição', async () => {
    const p = await pair();
    for (const status of ['saving', 'planned', 'paused', 'completed', 'cancelled'] as const) {
      const input = {
        name: status,
        targetAmount: 1000,
        savedAmount: 250,
        priority: 'high' as const,
        status,
        dueDate: '2027-01-10',
      };
      p.desktop.saveGoal(input);
      await p.mobile.saveGoal(input);
    }
    const comparable = (g: Awaited<ReturnType<MobileRepository['listGoals']>>[number]) => ({
      name: g.name,
      progress: g.progress,
      remainingAmount: g.remainingAmount,
      suggestedMonthlyAmount: g.suggestedMonthlyAmount,
      status: g.status,
    });
    expect((await p.mobile.listGoals()).map(comparable)).toEqual(
      p.desktop.listGoals().map(comparable),
    );
  });
});
