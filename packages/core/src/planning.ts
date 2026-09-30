import {
  addInterval,
  addMonths,
  cardStatementDueDate,
  dateForMonthDay,
  nextCardDueDate,
  toCents,
} from './finance';
import { isValidDate, validateMonth, validateTransaction } from './daily-finance';
import type {
  Catalogs,
  CreditCard,
  GoalInput,
  InstallmentPurchaseInput,
  RecurringExpenseInput,
  RecurringFrequency,
  RecurringIntervalUnit,
  Transaction,
} from './types';

/** Scheduling inputs independent of either platform's database columns. */
export interface RecurringSchedule {
  startMonth: string;
  startDate: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  intervalUnit: RecurringIntervalUnit;
  anchorToActual: boolean;
  manualMonths: string[];
  dueDay: number;
  chargeDay: number | null;
  cardId: string | null;
}
export const recurringInterval = (item: RecurringSchedule) => {
  if (item.frequency === 'weekly') return { count: 1, unit: 'weeks' as const };
  if (item.frequency === 'monthly') return { count: 1, unit: 'months' as const };
  return { count: item.intervalCount, unit: item.intervalUnit };
};

export function recurringOccurrence(
  item: Pick<RecurringSchedule, 'cardId' | 'dueDay'>,
  scheduledDate: string,
  card?: Pick<CreditCard, 'dueDay' | 'closingDay'>,
) {
  if (!item.cardId) return { purchaseDate: null, dueDate: scheduledDate, cardId: null };
  const dueDay = card?.dueDay ?? item.dueDay;
  return {
    purchaseDate: scheduledDate,
    dueDate:
      card?.closingDay == null
        ? nextCardDueDate(scheduledDate, dueDay)
        : cardStatementDueDate(scheduledDate, card.closingDay, dueDay),
    cardId: item.cardId,
  };
}

/** Fixed dates always start at the original anchor: Jan 31 → Feb 28 → Mar 31. */
export function fixedRecurringDates(item: RecurringSchedule, start: string, end: string): string[] {
  if (item.frequency === 'manual') {
    const dates: string[] = [];
    for (let month = `${start.slice(0, 7)}-01`; month < end; month = addMonths(month, 1)) {
      const iso = month.slice(0, 7);
      if (iso >= item.startMonth && item.manualMonths.includes(iso.slice(5)))
        dates.push(
          dateForMonthDay(iso, item.cardId ? (item.chargeDay ?? item.dueDay) : item.dueDay),
        );
    }
    return dates;
  }
  if (item.frequency === 'once')
    return item.startDate >= start && item.startDate < end ? [item.startDate] : [];
  const interval = recurringInterval(item);
  const dates: string[] = [];
  for (let index = 0; ; index += 1) {
    const date = addInterval(item.startDate, index * interval.count, interval.unit);
    if (date >= end) break;
    if (date >= start) dates.push(date);
  }
  return dates;
}

export function recurringEffectiveDate(
  item: Pick<RecurringSchedule, 'cardId'>,
  transaction: Pick<Transaction, 'purchaseDate' | 'status' | 'settledDate' | 'dueDate'>,
): string {
  return item.cardId && transaction.purchaseDate
    ? transaction.purchaseDate
    : (transaction.status === 'paid' || transaction.status === 'received') &&
        transaction.settledDate
      ? transaction.settledDate
      : transaction.dueDate;
}

export function rollingRecurringDates(
  item: RecurringSchedule,
  history: Array<Pick<Transaction, 'purchaseDate' | 'status' | 'settledDate' | 'dueDate'>>,
  start: string,
  end: string,
): string[] {
  const { count, unit } = recurringInterval(item);
  const lastDate = history
    .map((t) => recurringEffectiveDate(item, t))
    .sort()
    .at(-1);
  let date = lastDate ? addInterval(lastDate, count, unit) : item.startDate;
  const dates: string[] = [];
  while (date < end) {
    if (date >= start) dates.push(date);
    date = addInterval(date, count, unit);
  }
  return dates;
}

export function normalizeRecurring(input: RecurringExpenseInput, catalogs: Catalogs) {
  validateMonth(input.startMonth);
  if (!['once', 'weekly', 'monthly', 'custom', 'manual'].includes(input.frequency ?? 'monthly'))
    throw new Error('Frequência inválida.');
  const frequency = input.frequency ?? 'monthly';
  const intervalUnit = input.intervalUnit ?? 'months';
  if (!['days', 'weeks', 'months', 'years'].includes(intervalUnit))
    throw new Error('Intervalo inválido.');
  const intervalCount =
    frequency === 'custom' ? Math.min(999, Math.max(1, Math.round(input.intervalCount ?? 1))) : 1;
  if (!Number.isFinite(intervalCount)) throw new Error('Informe um intervalo válido.');
  const manualMonths =
    frequency === 'manual'
      ? [...new Set(input.manualMonths ?? [])].filter((m) => /^(0[1-9]|1[0-2])$/.test(m)).sort()
      : [];
  if (frequency === 'manual' && !manualMonths.length)
    throw new Error('Selecione pelo menos um mês.');
  const cardId = input.kind === 'expense' ? (input.cardId ?? null) : null;
  const card = catalogs.cards.find((c) => c.id === cardId);
  const chargeDay = cardId ? Math.min(31, Math.max(1, Math.round(input.chargeDay ?? 1))) : null;
  const dueDay = card?.dueDay ?? Math.min(31, Math.max(1, input.dueDay));
  if (!Number.isInteger(dueDay) || (chargeDay != null && !Number.isInteger(chargeDay)))
    throw new Error('Informe dias entre 1 e 31.');
  const startDate =
    frequency === 'monthly'
      ? dateForMonthDay(input.startMonth, chargeDay ?? dueDay)
      : (input.startDate ?? dateForMonthDay(input.startMonth, chargeDay ?? dueDay));
  validateTransaction({ ...input, cardId, dueDate: startDate, status: 'planned' }, catalogs);
  return {
    ...input,
    description: input.description.trim(),
    frequency,
    startDate,
    cardId,
    dueDay,
    chargeDay,
    intervalCount,
    intervalUnit,
    manualMonths,
    anchorToActual: frequency === 'custom' && Boolean(input.anchorToActual),
  };
}

export interface InstallmentHistory {
  id: string;
  installmentNumber: number;
  dueDate: string;
  status: Transaction['status'];
}
/** Desktop's correction semantics: renumber the series; preserve finalized amounts/dates. */
export function planInstallmentUpdate(
  input: InstallmentPurchaseInput,
  startingInstallment: number,
  history: InstallmentHistory[],
) {
  const total = Math.round(input.totalInstallments);
  const current = Math.round(input.currentInstallment);
  const shift = current - Math.round(input.originalCurrentInstallment ?? current);
  const starting = startingInstallment + shift;
  if (
    ![total, current, starting, shift].every(Number.isSafeInteger) ||
    starting < 1 ||
    current < starting ||
    current > total ||
    total < starting
  )
    throw new Error('Informe uma parcela entre 1 e o total da compra.');
  const shifted = history.map((t) => ({ ...t, installmentNumber: t.installmentNumber + shift }));
  const highestFinalized = shifted.reduce(
    (max, t) => (t.status !== 'planned' ? Math.max(max, t.installmentNumber) : max),
    0,
  );
  if (total < highestFinalized)
    throw new Error(
      `O total não pode ser menor que a parcela ${highestFinalized}, que já foi concluída.`,
    );
  const firstDueDate = addMonths(input.currentDueDate, -(current - 1));
  const finalizedDates = new Set(
    shifted.filter((t) => t.status !== 'planned').map((t) => t.dueDate),
  );
  const entries = Array.from({ length: total - starting + 1 }, (_, offset) => {
    const number = starting + offset;
    const existing = shifted.find((t) => t.installmentNumber === number);
    const dueDate = addMonths(firstDueDate, number - 1);
    // Keep the desktop's existing-item condition, including absent entries.
    if (existing?.status === 'planned' && finalizedDates.has(dueDate))
      throw new Error(
        'O novo calendário coincide com uma parcela já concluída. Ajuste a parcela atual ou a data da compra.',
      );
    return { number, dueDate, existing };
  });
  return { shift, starting, total, firstDueDate, entries };
}
export function validateInstallment(input: InstallmentPurchaseInput, catalogs: Catalogs) {
  if ((toCents(input.installmentAmount) ?? 0) < 1)
    throw new Error('Informe um valor de parcela maior que zero.');
  validateTransaction(
    {
      ...input,
      kind: 'expense',
      plannedAmount: input.installmentAmount,
      dueDate: input.currentDueDate,
      status: 'planned',
    },
    catalogs,
  );
  if (
    ![input.totalInstallments, input.currentInstallment].every(Number.isSafeInteger) ||
    input.totalInstallments < 1 ||
    input.currentInstallment < 1 ||
    input.currentInstallment > input.totalInstallments
  )
    throw new Error('Informe uma parcela atual entre 1 e o total da compra.');
}
export function validateGoal(input: GoalInput, catalogs: Catalogs) {
  if (!input.name.trim()) throw new Error('Informe o nome do objetivo.');
  if (
    ![input.targetAmount, input.savedAmount].every(
      (v) => Number.isFinite(v) && Number.isSafeInteger(toCents(v)),
    ) ||
    input.targetAmount < 0 ||
    input.savedAmount < 0
  )
    throw new Error('Informe valores válidos para o objetivo.');
  if (input.dueDate && !isValidDate(input.dueDate)) throw new Error('Informe um prazo válido.');
  if (!['planned', 'saving', 'completed', 'paused', 'cancelled'].includes(input.status))
    throw new Error('Situação inválida.');
  if (!['high', 'medium', 'low'].includes(input.priority)) throw new Error('Prioridade inválida.');
  if (input.categoryId && !catalogs.categories.some((c) => c.id === input.categoryId))
    throw new Error('Categoria não encontrada.');
}
