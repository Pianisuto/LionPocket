import { describe, expect, it } from 'vitest';
import {
  externalGoalUrl,
  leoMessage,
  leoMood,
  monthlyOverview,
  statusForDate,
  upcomingPayments,
} from './desktop-parity';
import { orderedTransactions } from './local-experience';
import type { Transaction } from './types';
const item = (changes: Partial<Transaction> = {}): Transaction => ({
  id: 'a',
  kind: 'expense',
  description: 'Conta',
  plannedAmount: 100,
  actualAmount: null,
  categoryId: 'cat',
  categoryName: 'Casa',
  categoryColor: '#abcdef',
  dueDate: '2026-09-30',
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
  ...changes,
});
describe('regras de experiência do desktop independentes de plataforma', () => {
  it('sugere realização apenas antes de hoje e respeita o tipo', () => {
    expect(statusForDate('2026-09-28', 'expense', '2026-09-29')).toBe('paid');
    expect(statusForDate('2026-09-28', 'income', '2026-09-29')).toBe(
      'received',
    );
    expect(statusForDate('2026-09-29', 'income', '2026-09-29')).toBe('planned');
    expect(statusForDate('2026-02-30', 'expense', '2026-09-29')).toBe(
      'planned',
    );
  });
  it('usa a competência do pagamento, exclui cancelados das saídas e limita recentes a seis', () => {
    const transactions = [
      item({
        id: 'paid',
        dueDate: '2026-08-10',
        settledDate: '2026-09-20',
        status: 'paid',
        actualAmount: 0,
      }),
      item({ id: 'later', settledDate: '2026-10-01', status: 'paid' }),
      item({ id: 'cancel', status: 'cancelled' }),
      ...Array.from({ length: 7 }, (_, n) =>
        item({ id: `new${n}`, dueDate: `2026-09-${20 + n}` }),
      ),
    ];
    const overview = monthlyOverview(transactions, [], '2026-09', '2026-09-29');
    expect(overview.categoryBreakdown).toEqual([
      { name: 'Casa', color: '#abcdef', amount: 700 },
    ]);
    expect(overview.summary.paidExpenses).toBe(0);
    expect(overview.recent).toHaveLength(6);
    expect(overview.upcoming).toHaveLength(7);
  });
  it('agrupa a fatura antes de limitar as cinco próximas contas e preserva itens para baixa', () => {
    const transactions = [
      item({ id: 'card1', cardId: 'visa', cardName: 'Visa' }),
      item({ id: 'card2', cardId: 'visa', cardName: 'Visa' }),
      ...Array.from({ length: 6 }, (_, n) =>
        item({ id: `other${n}`, dueDate: '2026-10-01', isOverdue: n === 0 }),
      ),
    ];
    const upcoming = upcomingPayments(transactions);
    expect(upcoming).toHaveLength(5);
    expect(upcoming[0].overdue).toBe(true);
    expect(upcoming.find((p) => p.cardInvoice)).toMatchObject({
      total: 200,
      items: transactions.slice(0, 2),
    });
  });
  it('ocultar prioridades aplica a ordenação normal sem alterar as posições guardadas', () => {
    const a = item({ id: 'a', description: 'Zebra', priorityPosition: 0 }),
      b = item({ id: 'b', description: 'Abacate' });
    expect(orderedTransactions([a, b], 'description').map((t) => t.id)).toEqual(
      ['a', 'b'],
    );
    expect(
      orderedTransactions([a, b], 'description', 'asc', false).map((t) => t.id),
    ).toEqual(['b', 'a']);
    expect(a.priorityPosition).toBe(0);
  });
  it('o Léo usa números reais, trata mês vazio e não apresenta valores fictícios', () => {
    const overview = monthlyOverview([item()], [], '2026-09', '2026-09-29');
    expect(leoMood(overview)).toBe('alarmed');
    expect(leoMessage(overview, 'month')).toContain('100,00');
    expect(leoMessage(overview, 'upcoming')).toContain('30/09/2026');
    expect(leoMessage(overview, 'goals')).toContain('ainda não');
    const empty = monthlyOverview([], [], '2026-09', '2026-09-29');
    expect(leoMood(empty)).toBe('neutral');
    expect(leoMessage(empty, 'month')).toContain('em branco');
  });
  it('links de objetivos permitem somente http/https, como no desktop', () => {
    expect(externalGoalUrl(' https://example.com/produto ')).toBe(
      'https://example.com/produto',
    );
    expect(() => externalGoalUrl('javascript:alert(1)')).toThrow();
    expect(() => externalGoalUrl('file:///etc/passwd')).toThrow();
  });
});
