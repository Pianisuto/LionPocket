import { describe, expect, it } from 'vitest';
import {
  isValidDate,
  summarizeMonth,
  transactionVisibleInMonth,
  validateTransaction,
} from './daily-finance';
import { addMonths, cardStatementDueDate } from './finance';
import type { Transaction } from './types';
const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'item',
  kind: 'expense',
  description: 'Conta',
  plannedAmount: 0.1,
  actualAmount: null,
  dueDate: '2026-09-30',
  settledDate: null,
  status: 'planned',
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  paymentMethodId: null,
  paymentMethodName: null,
  cardId: null,
  cardName: null,
  purchaseDate: null,
  notes: '',
  sourceType: 'manual',
  sourceId: null,
  installmentNumber: null,
  installmentTotal: null,
  isOverdue: false,
  priorityPosition: null,
  ...overrides,
});
describe('painel financeiro diário', () => {
  it('soma planejado e realizado em centavos e ignora cancelados', () => {
    const summary = summarizeMonth(
      [
        transaction({
          kind: 'income',
          plannedAmount: 100,
          actualAmount: 90,
          status: 'received',
        }),
        transaction({
          status: 'paid',
          actualAmount: 0.2,
          settledDate: '2026-09-29',
        }),
        transaction({ plannedAmount: 0.2 }),
        transaction({ plannedAmount: 999, status: 'cancelled' }),
        transaction({
          kind: 'income',
          plannedAmount: 200,
          dueDate: '2026-10-01',
        }),
      ],
      '2026-09',
      '2026-09-29',
    );
    expect(summary).toMatchObject({
      plannedIncome: 100,
      receivedIncome: 90,
      plannedExpenses: 0.3,
      paidExpenses: 0.2,
      projectedBalance: 99.7,
      realizedBalance: 89.8,
    });
  });
  it('preserva a regra assimétrica do desktop para receitas e despesas tardias', () => {
    const expense = transaction({
      dueDate: '2026-08-15',
      status: 'paid',
      settledDate: '2026-09-02',
    });
    const income = transaction({
      kind: 'income',
      dueDate: '2026-08-15',
      status: 'received',
      settledDate: '2026-09-02',
    });
    expect(transactionVisibleInMonth(expense, '2026-08')).toBe(true);
    expect(transactionVisibleInMonth(expense, '2026-09')).toBe(true);
    expect(transactionVisibleInMonth(income, '2026-09')).toBe(false);
    expect(summarizeMonth([expense, income], '2026-08', '2026-09-29')).toMatchObject({
      plannedIncome: 0.1,
      receivedIncome: 0.1,
      plannedExpenses: 0,
    });
    expect(summarizeMonth([expense, income], '2026-09', '2026-09-29')).toMatchObject({
      plannedIncome: 0,
      paidExpenses: 0.1,
    });
  });
  it('carrega atrasos para frente e mantém o histórico visível sem duplicar o saldo', () => {
    const item = transaction({ dueDate: '2026-08-15', isOverdue: true });
    expect(summarizeMonth([item], '2026-08', '2026-09-29').plannedExpenses).toBe(0);
    expect(summarizeMonth([item], '2026-09', '2026-09-29')).toMatchObject({
      plannedExpenses: 0.1,
      overdueExpenses: 0.1,
    });
    expect(summarizeMonth([item], '2026-10', '2026-09-29').plannedExpenses).toBe(0.1);
  });
  it('navega entre anos e respeita o fechamento do cartão', () => {
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(cardStatementDueDate('2026-09-19', 20, 5)).toBe('2026-10-05');
    expect(cardStatementDueDate('2026-09-20', 20, 5)).toBe('2026-11-05');
  });
  it('valida datas, valores e situações no domínio', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('foo')).toBe(false);
    expect(() => validateTransaction(transaction({ plannedAmount: NaN }))).toThrow();
    expect(() => validateTransaction(transaction({ status: 'paid', settledDate: null }))).toThrow();
    expect(() => validateTransaction(transaction({ kind: 'income', cardId: 'card' }))).toThrow();
    expect(() => summarizeMonth([], '2026-13')).toThrow();
  });
});
