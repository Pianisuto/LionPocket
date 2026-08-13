import { describe, expect, it } from 'vitest';
import { addMonths, calculateGoal, dateForMonthDay, fromCents, monthRange, toCents } from './finance';

describe('regras financeiras', () => {
  it('guarda valores em centavos sem erro de ponto flutuante', () => {
    expect(toCents(10.1 + 20.2)).toBe(3030);
    expect(fromCents(3030)).toBe(30.3);
  });

  it('calcula o início e o fim de um mês', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });

  it('ajusta vencimentos para o último dia do mês', () => {
    expect(dateForMonthDay('2026-02', 31)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('calcula progresso e sugestão mensal de um objetivo', () => {
    const result = calculateGoal(1200, 300, '2026-12-20', new Date('2026-08-13T12:00:00'));
    expect(result.remainingAmount).toBe(900);
    expect(result.progress).toBe(0.25);
    expect(result.suggestedMonthlyAmount).toBe(180);
  });
});

