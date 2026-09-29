import { describe, expect, it } from 'vitest';
import { parseTransactionForm } from './transactionForm';

describe('cadastro mobile de lançamentos', () => {
  it('normaliza centavos e marca uma despesa antiga como paga na competência correta', () => {
    expect(parseTransactionForm('expense', '  Mercado  ', '12,50', '2025-08-12', true)).toEqual({
      kind: 'expense',
      description: 'Mercado',
      plannedAmount: 12.5,
      actualAmount: 12.5,
      dueDate: '2025-08-12',
      settledDate: '2025-08-12',
      status: 'paid',
    });
  });

  it('mantém uma entrada futura como planejada', () => {
    const input = parseTransactionForm('income', 'Salário', '3000', '2099-01-10', false);
    expect(input.status).toBe('planned');
    expect(input.actualAmount).toBeNull();
    expect(input.settledDate).toBeNull();
  });

  it('rejeita valores e datas inválidos', () => {
    expect(() => parseTransactionForm('expense', 'Mercado', '0', '2026-09-29', false)).toThrow();
    expect(() => parseTransactionForm('expense', 'Mercado', '12,999', '2026-09-29', false)).toThrow();
    expect(() => parseTransactionForm('expense', 'Mercado', '12,50', '2026-02-30', false)).toThrow();
  });
});
