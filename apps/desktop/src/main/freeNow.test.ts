import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { GoalInput, GoalStatus, Overview, TransactionInput } from '@lionpocket/core';
import { LionPocketDatabase } from './database';
import { sqliteTestConnection } from '../../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../../mobile/src/db/migrations';
import { MobileRepository } from '../../../mobile/src/db/repository';

const close: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 9, 10, 15, 30) }));
afterEach(() => { vi.useRealTimers(); close.splice(0).reverse().forEach(f => f()); });

const tx = (kind: 'income' | 'expense', description: string, dueDate: string, plannedAmount: number, extra: Partial<TransactionInput> = {}): TransactionInput =>
  ({ kind, description, dueDate, plannedAmount, status: 'planned', ...extra });
const settled = (kind: 'income' | 'expense', description: string, dueDate: string, plannedAmount: number): TransactionInput =>
  tx(kind, description, dueDate, plannedAmount, { status: kind === 'income' ? 'received' : 'paid', actualAmount: plannedAmount, settledDate: dueDate });

/** One surface over both platforms: the same inputs must yield the same Dashboard numbers. */
async function subject(dialect: 'desktop' | 'android') {
  if (dialect === 'desktop') {
    const b = new LionPocketDatabase(':memory:'); close.push(() => b.db.close());
    return {
      saveTransaction: async (input: TransactionInput) => { b.saveTransaction(input); },
      saveGoal: async (input: GoalInput) => b.saveGoal(input).id,
      margin: async (month: string, safetyMarginCents: number) => b.saveMonthlyPlanning({ month, safetyMarginCents }),
      reinforce: async (goalId: string, month: string, amountCents: number) => b.saveGoalReinforcement({ goalId, month, amountCents }),
      overview: async (month: string): Promise<Overview> => b.getOverview(month),
      pause: async (id: string) => { b.db.prepare("UPDATE goals SET status='paused' WHERE id=?").run(id); },
    };
  }
  const m = sqliteTestConnection(); close.push(() => m.sqlite.close()); await migrate(m.db);
  const repo = new MobileRepository(m.db, randomUUID);
  return {
    saveTransaction: (input: TransactionInput) => repo.save(input),
    saveGoal: async (input: GoalInput) => { await repo.saveGoal(input); return (await repo.listGoals()).find(goal => goal.name === input.name)!.id; },
    margin: (month: string, safetyMarginCents: number) => repo.saveMonthlyPlanning({ month, safetyMarginCents }),
    reinforce: (goalId: string, month: string, amountCents: number) => repo.saveGoalReinforcement({ goalId, month, amountCents }),
    overview: async (month: string): Promise<Overview> => (await repo.monthlyOverview(month)) as Overview,
    pause: async (id: string) => { m.sqlite.prepare("UPDATE goals SET status='paused' WHERE id=?").run(id); },
  };
}
const goal = (name: string, status: GoalStatus = 'saving'): GoalInput => ({ name, targetAmount: 3000, savedAmount: 0, priority: 'medium', status, dueDate: '2027-03-10' });

async function seed(s: Awaited<ReturnType<typeof subject>>) {
  for (const input of [
    settled('income', 'Salário', '2026-10-05', 3000),
    settled('expense', 'Aluguel', '2026-10-02', 1000),
    tx('expense', 'Luz', '2026-10-12', 200),
    tx('expense', 'Internet', '2026-10-14', 100),
    tx('income', 'Freela', '2026-10-15', 500),
    tx('expense', 'Cartão', '2026-10-20', 400),
    tx('expense', 'Cancelada', '2026-10-13', 999, { status: 'cancelled' }),
  ]) await s.saveTransaction(input);
}

describe.each(['desktop', 'android'] as const)('Livre agora on %s', dialect => {
  it('uses persisted transactions, margin and reinforcements, with no new stored value', async () => {
    const s = await subject(dialect);
    await seed(s);
    const first = (await s.overview('2026-10')).freeNow!;
    expect(first).toMatchObject({ realizedBalanceCents: 200000, lowestPointCents: 170000, lowestPointDate: '2026-10-14', commitmentsUntilLowestPointCents: 30000, protectedMoneyCents: 0, freeNowCents: 170000 });
    expect(first.timeline.map(row => [row.date, row.balanceCents, row.lowest])).toEqual([
      ['2026-10-10', 200000, false], ['2026-10-12', 180000, false], ['2026-10-14', 170000, true], ['2026-10-15', 220000, false], ['2026-10-20', 180000, false],
    ]);
    await s.margin('2026-10', 50000);
    const notebook = await s.saveGoal(goal('Notebook'));
    const paused = await s.saveGoal(goal('Viagem'));
    await s.reinforce(notebook, '2026-10', 70000);
    await s.reinforce(paused, '2026-10', 30000);
    expect((await s.overview('2026-10')).freeNow).toMatchObject({ safetyMarginCents: 50000, goalReinforcementCents: 100000, protectedMoneyCents: 150000, freeNowCents: 20000 });
    await s.pause(paused);
    const overview = await s.overview('2026-10');
    expect(overview.freeNow).toMatchObject({ goalReinforcementCents: 70000, protectedMoneyCents: 120000, freeNowCents: 50000 });
    expect(overview.freeNow!.nextIncome).toEqual({ date: '2026-10-15', amountCents: 50000, count: 1, description: 'Freela' });
    expect(overview.protection).toMatchObject({ projectedBalanceCents: 180000, balanceAfterProtectionCents: 60000, protectedMoneyCents: 120000 });
  });
  it('is not available outside the current month, but protections still are', async () => {
    const s = await subject(dialect);
    await seed(s);
    await s.margin('2026-11', 50000);
    const next = await s.overview('2026-11');
    expect(next.freeNow).toBeNull();
    expect(next.protection).toMatchObject({ safetyMarginCents: 50000, protectedMoneyCents: 50000 });
    expect((await s.overview('2026-09')).freeNow).toBeNull();
  });
  it('without protections the overview keeps its original values', async () => {
    const s = await subject(dialect);
    await seed(s);
    const overview = await s.overview('2026-10');
    expect(overview.protection).toMatchObject({ protectedMoneyCents: 0, balanceAfterProtectionCents: overview.protection!.projectedBalanceCents });
    expect(overview.planning).toMatchObject({ safetyMargin: 0 });
  });
});

it('Desktop and Android produce identical Dashboard numbers for the same data', async () => {
  const results = [];
  for (const dialect of ['desktop', 'android'] as const) {
    const s = await subject(dialect);
    await seed(s);
    await s.margin('2026-10', 50000);
    await s.reinforce(await s.saveGoal(goal('Notebook')), '2026-10', 70000);
    const { freeNow, protection } = await s.overview('2026-10');
    // Row keys embed per-database ids, so parity compares everything else.
    results.push({ freeNow: { ...freeNow!, timeline: freeNow!.timeline.map(({ key: _key, ...row }) => row) }, protection });
  }
  expect(results[0]).toEqual(results[1]);
  expect(results[0].freeNow.freeNowCents).toBe(50000);
});
