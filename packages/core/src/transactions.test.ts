import { describe, expect, it } from 'vitest';
import type { Transaction } from './types';
import { applyPriorityChange, expenseCountsInMonth } from './transactions';

const transaction = (id: string, priorityPosition: number | null): Transaction => ({
  id,
  kind: 'expense',
  description: id,
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  plannedAmount: 100,
  actualAmount: null,
  purchaseDate: null,
  dueDate: '2099-08-10',
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
  priorityPosition,
});

const priorityIds = (items: Transaction[]) => items
  .filter((item) => item.priorityPosition !== null)
  .sort((left, right) => Number(left.priorityPosition) - Number(right.priorityPosition))
  .map((item) => item.id);

describe('estado otimista das prioridades', () => {
  it('continua permitindo pinar e despinar repetidamente sem travar a ordem', () => {
    let items = [transaction('internet', 0), transaction('água', null)];
    for (let index = 0; index < 8; index += 1) {
      const water = items.find((item) => item.id === 'água');
      if (!water) throw new Error('Lançamento ausente.');
      items = applyPriorityChange(items, water, true, null);
      expect(priorityIds(items)).toEqual(['internet', 'água']);
      items = applyPriorityChange(items, water, false, null);
      expect(priorityIds(items)).toEqual(['internet']);
    }
  });
});

describe('competência mensal das despesas', () => {
  it('conta pagamento tardio no mês em que ocorreu', () => {
    const paid = { ...transaction('paga', null), dueDate: '2026-07-10', settledDate: '2026-08-02', status: 'paid' as const };
    expect(expenseCountsInMonth(paid, '2026-07')).toBe(false);
    expect(expenseCountsInMonth(paid, '2026-08')).toBe(true);
  });

  it('carrega uma pendência vencida para o mês seguinte', () => {
    const overdue = { ...transaction('pendente', null), dueDate: '2020-07-10', isOverdue: true };
    expect(expenseCountsInMonth(overdue, '2020-07')).toBe(false);
    expect(expenseCountsInMonth(overdue, '2020-08')).toBe(true);
  });
});
