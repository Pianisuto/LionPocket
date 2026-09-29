import { describe, expect, it } from 'vitest';
import {
  fixedRecurringDates,
  normalizeRecurring,
  planInstallmentUpdate,
  recurringOccurrence,
  rollingRecurringDates,
} from './planning';
import type { RecurringSchedule } from './planning';
const schedule: RecurringSchedule = {
  startMonth: '2026-01',
  startDate: '2026-01-31',
  frequency: 'monthly',
  intervalCount: 1,
  intervalUnit: 'months',
  anchorToActual: false,
  manualMonths: [],
  dueDay: 31,
  chargeDay: null,
  cardId: null,
};
describe('calendário de planejamento compartilhado', () => {
  it('mantém a âncora ao atravessar fevereiro e um ano bissexto', () => {
    expect(fixedRecurringDates(schedule, '2026-01-01', '2026-04-01')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(
      fixedRecurringDates({ ...schedule, startDate: '2028-01-31' }, '2028-02-01', '2028-03-01'),
    ).toEqual(['2028-02-29']);
  });
  it('no fechamento cobra na fatura seguinte, inclusive vencimento no mês posterior', () => {
    const card = { dueDay: 5, closingDay: 20 };
    expect(recurringOccurrence({ ...schedule, cardId: 'c' }, '2026-09-19', card).dueDate).toBe(
      '2026-10-05',
    );
    expect(recurringOccurrence({ ...schedule, cardId: 'c' }, '2026-09-20', card).dueDate).toBe(
      '2026-11-05',
    );
  });
  it('calcula anos a partir do efetivo; cartão usa compra em vez de pagamento', () => {
    const item = {
      ...schedule,
      frequency: 'custom' as const,
      intervalUnit: 'years' as const,
      anchorToActual: true,
    };
    const history = [
      {
        purchaseDate: '2026-02-10',
        dueDate: '2026-02-15',
        status: 'paid' as const,
        settledDate: '2026-02-20',
      },
    ];
    expect(rollingRecurringDates(item, history, '2027-01-01', '2027-03-01')).toEqual([
      '2027-02-20',
    ]);
    expect(
      rollingRecurringDates({ ...item, cardId: 'c' }, history, '2027-01-01', '2027-03-01'),
    ).toEqual(['2027-02-10']);
  });
  it('bloqueia reduzir total abaixo de parcela concluída e colisão com seu vencimento', () => {
    const input = {
      description: 'Compra',
      installmentAmount: 100,
      currentInstallment: 2,
      totalInstallments: 3,
      currentDueDate: '2026-10-10',
    };
    const history = [
      { id: 'paid', installmentNumber: 1, status: 'paid' as const, dueDate: '2026-09-10' },
      { id: 'pending', installmentNumber: 2, status: 'planned' as const, dueDate: '2026-10-10' },
    ];
    expect(() =>
      planInstallmentUpdate({ ...input, currentDueDate: '2026-09-10' }, 1, history),
    ).toThrow('coincide');
    expect(() =>
      planInstallmentUpdate({ ...input, totalInstallments: 2 }, 1, [
        { ...history[0], installmentNumber: 3 },
      ]),
    ).toThrow('já foi concluída');
    expect(
      planInstallmentUpdate(
        { ...input, currentInstallment: 3, originalCurrentInstallment: 2 },
        1,
        history,
      ),
    ).toMatchObject({ shift: 1, starting: 2, total: 3 });
  });
  it('valida datas reais, intervalos e seleção manual antes de persistir no mobile', () => {
    const input = {
      kind: 'expense' as const,
      active: true,
      description: 'Conta',
      startMonth: '2026-09',
      dueDay: 10,
      plannedAmount: 100,
    };
    const catalogs = { categories: [], cards: [], paymentMethods: [] };
    expect(() =>
      normalizeRecurring({ ...input, frequency: 'once', startDate: '2026-02-30' }, catalogs),
    ).toThrow('data');
    expect(() => normalizeRecurring({ ...input, frequency: 'manual' }, catalogs)).toThrow('mês');
    expect(
      normalizeRecurring(
        { ...input, frequency: 'manual', manualMonths: ['12', '02', '02', '99'] },
        catalogs,
      ).manualMonths,
    ).toEqual(['02', '12']);
  });
});
