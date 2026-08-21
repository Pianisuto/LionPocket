import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../shared/types';
import { groupUpcoming } from './Dashboard';

const transaction = (overrides: Partial<Transaction>): Transaction => ({
  id: 'transaction',
  kind: 'expense',
  description: 'Compra',
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  plannedAmount: 100,
  actualAmount: null,
  purchaseDate: null,
  dueDate: '2026-07-21',
  settledDate: null,
  status: 'planned',
  paymentMethodId: 'credit',
  paymentMethodName: 'Cartão de crédito',
  cardId: 'nubank',
  cardName: 'NuBank',
  notes: '',
  sourceType: 'manual',
  sourceId: null,
  installmentNumber: null,
  installmentTotal: null,
  isOverdue: true,
  priorityPosition: null,
  ...overrides,
});

describe('agrupamento de contas a pagar', () => {
  it('agrupa compras atrasadas por cartão e vencimento, sem misturar faturas', () => {
    const groups = groupUpcoming([
      transaction({ id: 'a', plannedAmount: 100 }),
      transaction({ id: 'b', plannedAmount: 50 }),
      transaction({ id: 'c', dueDate: '2026-08-21', plannedAmount: 80 }),
      transaction({ id: 'd', cardId: 'other', cardName: 'Outro', plannedAmount: 30 }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      name: 'Fatura NuBank',
      dueDate: '2026-07-21',
      total: 150,
      overdue: true,
    });
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups.map((group) => group.total)).toEqual([150, 30, 80]);
  });

  it('mantém lançamentos comuns separados', () => {
    const groups = groupUpcoming([
      transaction({ id: 'boleto', description: 'Moto', cardId: null, paymentMethodId: null, paymentMethodName: 'Boleto' }),
      transaction({ id: 'current', description: 'Mercado', isOverdue: false }),
    ]);

    expect(groups).toMatchObject([
      { name: 'Moto', total: 100, cardInvoice: false },
      { name: 'Mercado', total: 100, cardInvoice: false },
    ]);
  });
});
