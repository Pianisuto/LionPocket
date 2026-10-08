import { describe, expect, it } from 'vitest';
import { calculateFreeNow, monthlyOverview, monthlyProtectionOverview, type Transaction } from '@lionpocket/core';
import { freeNowView, protectionLine } from './planningPresentation';

const tx = (kind: Transaction['kind'], dueDate: string, plannedAmount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `${kind}-${dueDate}-${plannedAmount}`, kind, description: extra.description ?? kind, categoryId: null, categoryName: null, categoryColor: null,
  plannedAmount, actualAmount: null, purchaseDate: null, dueDate, settledDate: null, status: 'planned', paymentMethodId: null, paymentMethodName: null,
  cardId: null, cardName: null, notes: '', sourceType: 'manual', sourceId: null, installmentNumber: null, installmentTotal: null,
  isOverdue: false, priorityPosition: null, ...extra,
});
const items = [
  tx('income', '2026-10-05', 3000, { status: 'received', actualAmount: 3000, settledDate: '2026-10-05' }),
  tx('expense', '2026-10-02', 1000, { status: 'paid', actualAmount: 1000, settledDate: '2026-10-02' }),
  tx('expense', '2026-10-12', 200), tx('expense', '2026-10-14', 100),
  tx('income', '2026-10-15', 500, { description: 'Freela' }), tx('expense', '2026-10-20', 400),
];
const goals = [{ id: 'g', status: 'saving' as const }];
const overview = (margin: number, reinforcement: number) =>
  monthlyOverview(items, goals as never[], '2026-10', '2026-10-10', margin ? { month: '2026-10', safetyMarginCents: margin } : null, reinforcement ? [{ goalId: 'g', month: '2026-10', amountCents: reinforcement }] : []);

describe('protection line under "Projetado"', () => {
  it('keeps both mobile balance cards unchanged without protections', () => {
    expect(protectionLine()).toBeNull();
    expect(protectionLine(overview(0, 0).protection)).toBeNull();
    expect(protectionLine(monthlyProtectionOverview([], [], [], { month: '2026-10', safetyMarginCents: 0 }, '2026-10', '2026-10-10', 3200).protection)).toBeNull();
  });
  it('shows the available amount after protections, including a negative result, in pt-BR', () => {
    expect(protectionLine(overview(50000, 0).protection)).toMatchObject({ negative: false, text: expect.stringMatching(/1\.300,00 após margem de segurança/) });
    expect(protectionLine(overview(50000, 70000).protection)).toMatchObject({ text: expect.stringMatching(/600,00 após proteções/) });
    expect(protectionLine(overview(150000, 70000).protection)).toMatchObject({ negative: true, text: expect.stringMatching(/-R\$.*400,00 após proteções/) });
  });
});

describe('Livre agora view', () => {
  it('has no view outside the current month', () => {
    expect(freeNowView(null)).toBeNull();
    expect(freeNowView(undefined)).toBeNull();
    expect(freeNowView(monthlyOverview(items, [], '2026-11', '2026-10-10').freeNow)).toBeNull();
  });
  it('formats the shared calculation and its composition, with identical cents to the core', () => {
    const data = overview(50000, 70000);
    const view = freeNowView(data.freeNow)!;
    expect(data.freeNow).toEqual(calculateFreeNow(items, '2026-10', '2026-10-10', { month: '2026-10', safetyMarginCents: 50000 }, goals, [{ goalId: 'g', month: '2026-10', amountCents: 70000 }]));
    expect(view).toMatchObject({ label: 'Pode gastar hoje', negative: false, note: 'Sem ficar no vermelho este mês. O mais apertado é 14/10.' });
    expect(view.value).toMatch(/500,00/);
    expect(view.timeline.map((row) => [row.date, row.balance.replace(/\s/g, ' '), row.lowest])).toEqual([
      ['Hoje', 'R$ 2.000,00', false], ['12/10', 'R$ 1.800,00', false], ['14/10', 'R$ 1.700,00', true], ['15/10', 'R$ 2.200,00', false], ['20/10', 'R$ 1.800,00', false],
    ]);
    expect(view.timeline[3]).toMatchObject({ label: 'Freela', delta: expect.stringMatching(/^\+ .*500,00/) });
    expect(view.timeline[1].delta).toMatch(/^− .*200,00/);
    expect(view.lines.map((line) => [line.key, line.negative])).toEqual([['lowest', false], ['safetyMargin', true], ['goals', true]]);
    expect(view.lines[0].value).toMatch(/1\.700,00/);
    expect(view.lines[0].label).toBe('Menor saldo do mês (14/10)');
  });
  it('shows a negative result as negative', () => {
    const view = freeNowView(overview(150000, 70000).freeNow)!;
    expect(view).toMatchObject({ negative: true, label: 'Faltam', note: expect.stringContaining('até 14/10') });
    expect(view.value).toMatch(/500,00/);
    expect(view.value).not.toMatch(/-/);
  });
  it('leaves out protections that are zero', () => {
    expect(freeNowView(overview(0, 0).freeNow)!.lines.map((line) => line.key)).toEqual(['lowest']);
  });
});
