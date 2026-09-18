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

  it('agrupa compras atuais do cartão e mantém lançamentos comuns separados', () => {
    const groups = groupUpcoming([
      transaction({ id: 'boleto', description: 'Moto', cardId: null, paymentMethodId: null, paymentMethodName: 'Boleto' }),
      transaction({ id: 'current-a', description: 'Mercado', isOverdue: false }),
      transaction({ id: 'current-b', description: 'Farmácia', plannedAmount: 50, isOverdue: false }),
    ]);

    expect(groups).toMatchObject([
      { name: 'Moto', total: 100, cardInvoice: false },
      {
        name: 'Fatura NuBank',
        total: 150,
        overdue: false,
        cardInvoice: true,
        detail: '2 compras na fatura',
      },
    ]);
    expect(groups[1].items.map((item) => item.id)).toEqual(['current-a', 'current-b']);
  });

  it('consolida compras no crédito sem cartão identificado', () => {
    const groups = groupUpcoming([
      transaction({ id: 'unassigned-a', cardId: null, cardName: null, isOverdue: false }),
      transaction({ id: 'unassigned-b', cardId: null, cardName: null, plannedAmount: 25, isOverdue: false }),
    ]);

    expect(groups).toMatchObject([{
      name: 'Fatura sem cartão informado',
      total: 125,
      cardInvoice: true,
      detail: '2 compras na fatura',
    }]);
  });
});
