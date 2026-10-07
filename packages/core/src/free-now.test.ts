import { describe, expect, it } from 'vitest';
import {
  calculateFreeNow,
  freeNowComposition,
  freeNowHorizon,
  monthlyProtectionOverview,
  nextIncomeOf,
  protectedMoney,
  protectionBalance,
  protectionHint,
} from './free-now';
import { monthlyOverview } from './desktop-parity';
import { summarizeMonth } from './daily-finance';
import type { GoalMonthlyReinforcement, GoalStatus, MonthlyPlanning, Transaction } from './types';

const TODAY = '2026-10-10';
const MONTH = '2026-10';

let sequence = 0;
const tx = (overrides: Partial<Transaction> & Pick<Transaction, 'kind' | 'dueDate'>, today = TODAY): Transaction => {
  const item: Transaction = {
    id: `t${++sequence}`,
    description: 'Lançamento',
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    plannedAmount: 100,
    actualAmount: null,
    purchaseDate: null,
    settledDate: null,
    status: 'planned',
    paymentMethodId: null,
    paymentMethodName: null,
    cardId: null,
    cardName: null,
    notes: '',
    sourceType: 'manual',
    sourceId: null,
    installmentNumber: null,
    installmentTotal: null,
    isOverdue: false,
    priorityPosition: null,
    ...overrides,
  };
  return { ...item, isOverdue: overrides.isOverdue ?? (item.kind === 'expense' && item.status === 'planned' && item.dueDate < today) };
};
const income = (dueDate: string, plannedAmount: number, overrides: Partial<Transaction> = {}) =>
  tx({ kind: 'income', dueDate, plannedAmount, description: 'Entrada', ...overrides });
const expense = (dueDate: string, plannedAmount: number, overrides: Partial<Transaction> = {}) =>
  tx({ kind: 'expense', dueDate, plannedAmount, description: 'Conta', ...overrides });
const received = (dueDate: string, amount: number) =>
  income(dueDate, amount, { status: 'received', actualAmount: amount, settledDate: dueDate });
const paid = (dueDate: string, amount: number, overrides: Partial<Transaction> = {}) =>
  expense(dueDate, amount, { status: 'paid', actualAmount: amount, settledDate: dueDate, ...overrides });

const goal = (id: string, status: GoalStatus) => ({ id, status });
const planning = (safetyMarginCents: number, month = MONTH): MonthlyPlanning => ({ month, safetyMarginCents });
const reinforcement = (goalId: string, amountCents: number, month = MONTH): GoalMonthlyReinforcement => ({ goalId, month, amountCents });

/** Salary received (3000), rent paid (1000) → realized 2000; 300 due before the next income on the 15th. */
const baseMonth = () => [
  received('2026-10-05', 3000),
  paid('2026-10-02', 1000),
  expense('2026-10-12', 200, { description: 'Luz' }),
  expense('2026-10-14', 100, { description: 'Internet' }),
  income('2026-10-15', 500, { description: 'Freela' }),
  expense('2026-10-20', 400, { description: 'Cartão' }),
];

const free = (items: Transaction[], plan: MonthlyPlanning | null = null, goals: { id: string; status: GoalStatus }[] = [], rows: GoalMonthlyReinforcement[] = [], today = TODAY, month = MONTH) =>
  calculateFreeNow(items, month, today, plan, goals, rows);

describe('protectedMoney', () => {
  it('is zero without margin or reinforcements', () => {
    expect(protectedMoney(null, [], [], MONTH)).toEqual({ month: MONTH, safetyMarginCents: 0, goalReinforcementCents: 0, protectedMoneyCents: 0 });
  });
  it('counts only the margin', () => {
    expect(protectedMoney(planning(50000), [], [], MONTH)).toMatchObject({ safetyMarginCents: 50000, goalReinforcementCents: 0, protectedMoneyCents: 50000 });
  });
  it('counts only reinforcements, summed across goals', () => {
    const goals = [goal('a', 'saving'), goal('b', 'planned')];
    expect(protectedMoney(null, goals, [reinforcement('a', 70000), reinforcement('b', 1234)], MONTH))
      .toMatchObject({ safetyMarginCents: 0, goalReinforcementCents: 71234, protectedMoneyCents: 71234 });
  });
  it('adds margin and reinforcements', () => {
    expect(protectedMoney(planning(50000), [goal('a', 'saving')], [reinforcement('a', 70000)], MONTH).protectedMoneyCents).toBe(120000);
  });
  it('ignores paused, completed, cancelled and deleted goals, keeping their history out of the total', () => {
    const goals = [goal('p', 'paused'), goal('c', 'completed'), goal('x', 'cancelled'), goal('ok', 'saving')];
    const rows = [reinforcement('p', 100), reinforcement('c', 200), reinforcement('x', 300), reinforcement('ok', 400), reinforcement('gone', 500)];
    expect(protectedMoney(null, goals, rows, MONTH).goalReinforcementCents).toBe(400);
  });
  it('keeps months independent: nothing carries over', () => {
    const rows = [reinforcement('a', 700, '2026-09'), reinforcement('a', 900, '2026-11')];
    expect(protectedMoney(planning(50000, '2026-09'), [goal('a', 'saving')], rows, MONTH).protectedMoneyCents).toBe(0);
    expect(protectedMoney(planning(50000, '2026-09'), [goal('a', 'saving')], rows, '2026-11').protectedMoneyCents).toBe(900);
  });
  it('rejects invalid months and margins', () => {
    expect(() => protectedMoney(null, [], [], '2026-13')).toThrow();
    expect(() => protectedMoney(planning(-1), [], [], MONTH)).toThrow();
  });
});

describe('protectionBalance and hint', () => {
  it('subtracts in cents and does not clamp to zero', () => {
    const balance = protectionBalance(300, protectedMoney(planning(50000), [], [], MONTH));
    expect(balance).toMatchObject({ projectedBalanceCents: 30000, balanceAfterProtectionCents: -20000 });
  });
  it('has no hint without protections, keeping the original card', () => {
    expect(protectionHint(protectionBalance(3200, protectedMoney(null, [], [], MONTH)))).toBeNull();
    expect(protectionHint(protectionBalance(3200, protectedMoney(planning(0), [], [], MONTH)))).toBeNull();
    expect(protectionHint(undefined)).toBeNull();
  });
  it('names the protection that applies', () => {
    const goals = [goal('a', 'saving')];
    const rows = [reinforcement('a', 70000)];
    expect(protectionHint(protectionBalance(3200, protectedMoney(planning(50000), [], [], MONTH)))).toMatch(/2\.700,00 após margem de segurança/);
    expect(protectionHint(protectionBalance(3200, protectedMoney(null, goals, rows, MONTH)))).toMatch(/2\.500,00 após reforços dos objetivos/);
    expect(protectionHint(protectionBalance(3200, protectedMoney(planning(50000), goals, rows, MONTH)))).toMatch(/2\.000,00 após proteções/);
    expect(protectionHint(protectionBalance(300, protectedMoney(planning(50000), [], [], MONTH)))).toMatch(/-R\$.*200,00 após margem de segurança/);
  });
});

describe('Livre agora', () => {
  it('without margin or goals: realized balance minus bills before the next income', () => {
    const result = free(baseMonth())!;
    expect(result).toMatchObject({
      protectedMoneyCents: 0,
      realizedBalanceCents: 200000,
      commitmentsBeforeNextIncomeCents: 30000,
      commitmentsUntil: '2026-10-15',
      freeNowCents: 170000,
    });
    expect(result.nextIncome).toEqual({ date: '2026-10-15', amountCents: 50000, count: 1, description: 'Freela' });
  });

  it('uses the same realized balance shown by the "Saldo realizado" card', () => {
    const items = baseMonth();
    expect(free(items)!.realizedBalanceCents).toBe(Math.round(summarizeMonth(items, MONTH, TODAY).realizedBalance * 100));
  });

  it('subtracts only the margin', () => {
    expect(free(baseMonth(), planning(50000))!.freeNowCents).toBe(120000);
  });
  it('subtracts only active goal reinforcements', () => {
    const goals = [goal('a', 'saving'), goal('paused', 'paused')];
    expect(free(baseMonth(), null, goals, [reinforcement('a', 70000), reinforcement('paused', 99999)])!.freeNowCents).toBe(100000);
  });
  it('subtracts margin and reinforcements, exposing the composition', () => {
    const result = free(baseMonth(), planning(50000), [goal('a', 'saving')], [reinforcement('a', 70000)])!;
    expect(result).toMatchObject({ safetyMarginCents: 50000, goalReinforcementCents: 70000, protectedMoneyCents: 120000, freeNowCents: 50000 });
    expect(freeNowComposition(result)).toEqual([
      { key: 'realized', label: 'Saldo realizado do mês', cents: 200000 },
      { key: 'commitments', label: 'Contas antes da próxima entrada', cents: -30000 },
      { key: 'safetyMargin', label: 'Margem de segurança', cents: -50000 },
      { key: 'goals', label: 'Objetivos', cents: -70000 },
    ]);
    expect(freeNowComposition(result).reduce((sum, line) => sum + line.cents, 0)).toBe(result.freeNowCents);
  });
  it('omits zero protections from the composition', () => {
    expect(freeNowComposition(free(baseMonth())!).map((line) => line.key)).toEqual(['realized', 'commitments']);
  });

  it('next income tomorrow only counts what is due today or tomorrow', () => {
    const items = [received('2026-10-01', 1000), expense('2026-10-10', 50), expense('2026-10-11', 30), expense('2026-10-12', 999), income('2026-10-11', 800)];
    const result = free(items)!;
    expect(result.nextIncome?.date).toBe('2026-10-11');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(8000);
    expect(result.freeNowCents).toBe(100000 - 8000);
  });
  it('sums several bills before the next income', () => {
    const items = [received('2026-10-01', 1000), expense('2026-10-11', 10.1), expense('2026-10-12', 20.2), expense('2026-10-13', 30.3), income('2026-10-14', 5000)];
    expect(free(items)!.commitmentsBeforeNextIncomeCents).toBe(6060);
  });
  it('bills after the next income do not reduce the immediate value', () => {
    const items = [received('2026-10-01', 1000), income('2026-10-12', 500), expense('2026-10-13', 700), expense('2026-10-30', 900)];
    expect(free(items)!.commitmentsBeforeNextIncomeCents).toBe(0);
    expect(free(items)!.freeNowCents).toBe(100000);
  });
  it('a bill due on the same day as the next income counts as before it (deterministic, conservative)', () => {
    const items = [received('2026-10-01', 1000), income('2026-10-15', 500), expense('2026-10-15', 120), expense('2026-10-16', 80)];
    expect(free(items)!.commitmentsBeforeNextIncomeCents).toBe(12000);
  });
  it('an income still planned for today is the next income, and bills due today count', () => {
    const items = [received('2026-10-01', 1000), income('2026-10-10', 500), expense('2026-10-10', 60), expense('2026-10-11', 40)];
    const result = free(items)!;
    expect(result.nextIncome?.date).toBe('2026-10-10');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(6000);
    expect(result.realizedBalanceCents).toBe(100000);
  });
  it('adds incomes of the same date and drops the single description', () => {
    const items = [income('2026-10-15', 500, { description: 'B' }), income('2026-10-15', 250, { description: 'A' }), income('2026-10-20', 9)];
    expect(nextIncomeOf(items, MONTH, TODAY)).toEqual({ date: '2026-10-15', amountCents: 75000, count: 2, description: null });
  });

  it('an already received income is neither future nor the next income', () => {
    const items = [received('2026-10-05', 3000), received('2026-10-15', 500), expense('2026-10-12', 200), expense('2026-10-20', 400)];
    const result = free(items)!;
    expect(result.nextIncome).toBeNull();
    expect(result.realizedBalanceCents).toBe(350000);
    expect(result.commitmentsBeforeNextIncomeCents).toBe(60000);
  });
  it('a late planned income is not counted on: it neither anchors nor adds to the balance', () => {
    const items = [received('2026-10-01', 1000), income('2026-10-05', 700), expense('2026-10-12', 100), income('2026-10-20', 500), expense('2026-10-25', 300)];
    const result = free(items)!;
    expect(result.nextIncome?.date).toBe('2026-10-20');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(10000);
    expect(result.realizedBalanceCents).toBe(100000);
  });
  it('an already paid bill is not charged again', () => {
    const items = [received('2026-10-01', 1000), paid('2026-10-12', 300), income('2026-10-15', 500)];
    const result = free(items)!;
    expect(result.commitmentsBeforeNextIncomeCents).toBe(0);
    expect(result.realizedBalanceCents).toBe(70000);
    expect(result.freeNowCents).toBe(70000);
  });
  it('a paid bill uses the amount actually paid for the balance', () => {
    const items = [received('2026-10-01', 1000), paid('2026-10-03', 80, { plannedAmount: 100 })];
    expect(free(items)!.realizedBalanceCents).toBe(92000);
  });
  it('cancelled entries are ignored, as expenses and as incomes', () => {
    const items = [received('2026-10-01', 1000), expense('2026-10-12', 300, { status: 'cancelled' }), income('2026-10-11', 900, { status: 'cancelled' }), income('2026-10-15', 500), expense('2026-10-13', 50)];
    const result = free(items)!;
    expect(result.nextIncome?.date).toBe('2026-10-15');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(5000);
  });
  it('without a future income, every pending bill until the end of the month counts', () => {
    const items = [received('2026-10-01', 1000), expense('2026-10-12', 100), expense('2026-10-31', 200)];
    const result = free(items)!;
    expect(result.nextIncome).toBeNull();
    expect(result.commitmentsUntil).toBe('2026-10-31');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(30000);
    expect(freeNowHorizon(result)).toMatch(/até o fim do mês/);
    expect(freeNowComposition(result)[1].label).toBe('Contas até o fim do mês');
  });
  it('the last day of February is respected when no income is planned', () => {
    const result = calculateFreeNow([expense('2028-02-29', 10)], '2028-02', '2028-02-20', null, [], [])!;
    expect(result.commitmentsUntil).toBe('2028-02-29');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(1000);
  });
  it('negative results are kept, never clamped to zero', () => {
    const items = [received('2026-10-01', 100), expense('2026-10-11', 250), income('2026-10-15', 500)];
    const result = free(items, planning(5000))!;
    expect(result.freeNowCents).toBe(10000 - 25000 - 5000);
    expect(result.freeNowCents).toBeLessThan(0);
  });
  it('overdue bills, including those carried from earlier months, are commitments before any next income', () => {
    const items = [received('2026-10-01', 1000), expense('2026-09-20', 150), expense('2026-10-03', 50), income('2026-10-15', 500)];
    const result = free(items)!;
    expect(items[1].isOverdue).toBe(true);
    expect(result.commitmentsBeforeNextIncomeCents).toBe(20000);
  });
  it('ignores zero-value entries', () => {
    const items = [received('2026-10-01', 100), income('2026-10-12', 0), expense('2026-10-11', 0), income('2026-10-20', 300)];
    const result = free(items)!;
    expect(result.nextIncome?.date).toBe('2026-10-20');
    expect(result.commitmentsBeforeNextIncomeCents).toBe(0);
  });

  it('cards, installments and recurrences count by the due date the system already computed, once', () => {
    const items = [
      received('2026-10-01', 2000),
      expense('2026-10-12', 150, { description: 'Compra A', cardId: 'nu', cardName: 'NuBank', paymentMethodName: 'Cartão de crédito' }),
      expense('2026-10-12', 50, { description: 'Compra B', cardId: 'nu', cardName: 'NuBank', paymentMethodName: 'Cartão de crédito' }),
      expense('2026-10-14', 120, { description: 'Notebook 3/10', sourceType: 'installment', sourceId: 'inst', installmentNumber: 3, installmentTotal: 10 }),
      expense('2026-10-14', 35, { description: 'Streaming', sourceType: 'recurring', sourceId: 'rec' }),
      expense('2026-10-25', 120, { description: 'Notebook 4/10', sourceType: 'installment', sourceId: 'inst', installmentNumber: 4, installmentTotal: 10 }),
      income('2026-10-15', 500),
    ];
    expect(free(items)!.commitmentsBeforeNextIncomeCents).toBe(15000 + 5000 + 12000 + 3500);
  });
  it('a settled card invoice leaves the commitments and enters the realized balance once', () => {
    const open = [received('2026-10-01', 1000), expense('2026-10-12', 200, { cardId: 'nu' }), income('2026-10-15', 500)];
    const settled = [open[0], { ...open[1], status: 'paid' as const, actualAmount: 200, settledDate: '2026-10-10', isOverdue: false }, open[2]];
    expect(free(open)!.freeNowCents).toBe(80000);
    expect(free(settled)!.freeNowCents).toBe(80000);
    expect(free(settled)!.commitmentsBeforeNextIncomeCents).toBe(0);
  });

  it('is only defined for the current month', () => {
    expect(free(baseMonth(), null, [], [], TODAY, '2026-11')).toBeNull();
    expect(free(baseMonth(), null, [], [], TODAY, '2026-09')).toBeNull();
  });
  it('month rollover: each month uses its own margin and goals, and nothing carries over', () => {
    const rows = [reinforcement('a', 70000, '2026-10'), reinforcement('a', 10000, '2026-11')];
    const goals = [goal('a', 'saving')];
    const lastDay = calculateFreeNow([received('2026-10-01', 1000)], '2026-10', '2026-10-31', planning(50000, '2026-10'), goals, rows)!;
    const firstDay = calculateFreeNow([received('2026-11-01', 1000)], '2026-11', '2026-11-01', planning(50000, '2026-10'), goals, rows)!;
    expect(lastDay.protectedMoneyCents).toBe(120000);
    expect(firstDay.protectedMoneyCents).toBe(10000);
    expect(firstDay.freeNowCents).toBe(90000);
    expect(calculateFreeNow([], '2026-11', '2026-10-31', null, [], [])).toBeNull();
  });
  it('on the last day, an income of the next month is not an anchor for this period', () => {
    const items = [received('2026-10-01', 500), expense('2026-10-31', 100), income('2026-11-05', 3000), expense('2026-11-03', 999)];
    const result = calculateFreeNow(items, '2026-10', '2026-10-31', null, [], [])!;
    expect(result.nextIncome).toBeNull();
    expect(result.commitmentsBeforeNextIncomeCents).toBe(10000);
  });
  it('rejects an invalid date', () => {
    expect(() => calculateFreeNow([], MONTH, '2026-10-32', null, [], [])).toThrow();
  });
  it('does not mutate the inputs', () => {
    const items = baseMonth();
    const snapshot = JSON.stringify(items);
    free(items, planning(100), [goal('a', 'saving')], [reinforcement('a', 1)]);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
  it('describes the period in words', () => {
    expect(freeNowHorizon(free(baseMonth())!)).toBe('Até a próxima entrada: Freela, em 15/10.');
    const several = free([income('2026-10-15', 5), income('2026-10-15', 6)])!;
    expect(freeNowHorizon(several)).toBe('Até a próxima entrada: 2 entradas, em 15/10.');
  });
});

describe('overview integration', () => {
  it('monthlyOverview exposes the derived protection and Livre agora, identical to the direct calculation', () => {
    const items = baseMonth();
    const goals = [{ ...goal('a', 'saving'), name: 'N' }] as never[];
    const overview = monthlyOverview(items, goals, MONTH, TODAY, planning(50000), [reinforcement('a', 70000)]);
    expect(overview.freeNow).toEqual(free(items, planning(50000), [goal('a', 'saving')], [reinforcement('a', 70000)]));
    expect(overview.protection).toMatchObject({ protectedMoneyCents: 120000, projectedBalanceCents: overview.summary.projectedBalance * 100, balanceAfterProtectionCents: overview.summary.projectedBalance * 100 - 120000 });
  });
  it('keeps the original behaviour without protections', () => {
    const overview = monthlyOverview(baseMonth(), [], MONTH, TODAY, null);
    expect(protectionHint(overview.protection)).toBeNull();
    expect(overview.planning).toEqual({ projectedBalance: overview.summary.projectedBalance, safetyMargin: 0, balanceAfterSafetyMargin: overview.summary.projectedBalance });
  });
  it('protection is available for other months while Livre agora is not', () => {
    const result = monthlyProtectionOverview([], [], [], planning(50000, '2026-11'), '2026-11', TODAY, 100);
    expect(result.freeNow).toBeNull();
    expect(result.protection).toMatchObject({ protectedMoneyCents: 50000, balanceAfterProtectionCents: -40000 });
  });
});
