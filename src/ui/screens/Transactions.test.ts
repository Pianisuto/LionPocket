import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../shared/types';
import { applyPriorityChange, groupTransactions, sortTransactions, transactionColumns } from './Transactions';

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

describe('ordenação dos lançamentos', () => {
  it('ordena a data da compra e mantém lançamentos sem data no fim', () => {
    const items = [
      { ...transaction('sem-data', null), purchaseDate: null },
      { ...transaction('mais-recente', null), purchaseDate: '2026-08-20' },
      { ...transaction('mais-antiga', null), purchaseDate: '2026-07-10' },
    ];

    expect(sortTransactions(items, { key: 'purchaseDate', direction: 'asc' }).map((item) => item.id))
      .toEqual(['mais-antiga', 'mais-recente', 'sem-data']);
    expect(sortTransactions(items, { key: 'purchaseDate', direction: 'desc' }).map((item) => item.id))
      .toEqual(['mais-recente', 'mais-antiga', 'sem-data']);
  });

  it('posiciona a data da compra imediatamente antes da situação', () => {
    expect(transactionColumns.map((column) => column.key))
      .toEqual(['date', 'description', 'category', 'paymentMethod', 'card', 'purchaseDate', 'status', 'amount']);
  });
});

describe('visibilidade das prioridades', () => {
  it('mantém todos os lançamentos na lista normal quando a região está desativada', () => {
    const items = [transaction('fixado', 0), transaction('comum', null)];
    const sortedItems = sortTransactions(items, { key: 'description', direction: 'asc' });

    expect(groupTransactions(items, sortedItems, false)).toEqual({
      priorityItems: [],
      regularItems: [items[1], items[0]],
    });
  });

  it('separa os lançamentos fixados quando a região está ativada', () => {
    const items = [transaction('fixado', 0), transaction('comum', null)];
    const sortedItems = sortTransactions(items, { key: 'description', direction: 'asc' });

    expect(groupTransactions(items, sortedItems, true)).toEqual({
      priorityItems: [items[0]],
      regularItems: [items[1]],
    });
  });
});
