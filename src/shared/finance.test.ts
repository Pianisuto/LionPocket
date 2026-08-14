import { describe, expect, it } from 'vitest';
import {
  addMonths,
  cardStatementDueDate,
  calculateGoal,
  dateForMonthDay,
  fromCents,
  isPastDate,
  localDateIso,
  monthRange,
  nextCardDueDate,
  settlementDateFor,
  toCents,
} from './finance';

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

  it('sugere o próximo vencimento do cartão sem usar uma data passada', () => {
    expect(nextCardDueDate('2026-08-04', 10)).toBe('2026-08-10');
    expect(nextCardDueDate('2026-08-14', 10)).toBe('2026-09-10');
    expect(nextCardDueDate('2026-01-31', 31)).toBe('2026-01-31');
    expect(nextCardDueDate('2026-02-15', 31)).toBe('2026-02-28');
  });

  it('coloca a compra na fatura certa usando fechamento e vencimento', () => {
    expect(cardStatementDueDate('2026-08-10', 14, 21)).toBe('2026-08-21');
    expect(cardStatementDueDate('2026-08-14', 14, 21)).toBe('2026-09-21');
    expect(cardStatementDueDate('2026-08-15', 14, 21)).toBe('2026-09-21');
    expect(cardStatementDueDate('2026-08-20', 25, 5)).toBe('2026-09-05');
    expect(cardStatementDueDate('2026-08-26', 25, 5)).toBe('2026-10-05');
  });

  it('ajusta fechamento e vencimento ao tamanho do mês', () => {
    expect(cardStatementDueDate('2026-02-10', 14, 31)).toBe('2026-02-28');
    expect(cardStatementDueDate('2026-02-15', 14, 31)).toBe('2026-03-31');
  });

  it('usa a data local, e não UTC, para saber que dia é hoje', () => {
    // 23h de 14/08 em São Paulo já é 15/08 em UTC.
    expect(localDateIso(new Date(2026, 7, 14, 23, 30))).toBe('2026-08-14');
  });

  it('reconhece uma data que já passou', () => {
    expect(isPastDate('2026-07-10', '2026-08-14')).toBe(true);
    expect(isPastDate('2026-08-14', '2026-08-14')).toBe(false);
    expect(isPastDate('2026-09-01', '2026-08-14')).toBe(false);
    expect(isPastDate('', '2026-08-14')).toBe(false);
  });

  it('data um lançamento antigo no próprio vencimento, não em hoje', () => {
    expect(settlementDateFor('2026-07-10', '2026-08-14')).toBe('2026-07-10');
    expect(settlementDateFor('2026-08-30', '2026-08-14')).toBe('2026-08-14');
  });

  it('calcula progresso e sugestão mensal de um objetivo', () => {
    const result = calculateGoal(1200, 300, '2026-12-20', new Date('2026-08-13T12:00:00'));
    expect(result.remainingAmount).toBe(900);
    expect(result.progress).toBe(0.25);
    expect(result.suggestedMonthlyAmount).toBe(180);
  });
});
