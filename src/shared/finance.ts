import type { MonthSummary } from './types';

export const toCents = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 100);
};

export const fromCents = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  return value / 100;
};

/**
 * Data local em ISO. `toISOString` devolve UTC: à noite, no horário de São
 * Paulo, ele já mostra o dia seguinte — e o lançamento cairia no dia errado.
 */
export const localDateIso = (date: Date = new Date()): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

export const todayIso = () => localDateIso();

export const currentMonthIso = () => todayIso().slice(0, 7);

/** Uma data que já passou: o sinal de que aquilo ali provavelmente já aconteceu. */
export const isPastDate = (date: string, today = todayIso()) => Boolean(date) && date < today;

/**
 * Quando um lançamento foi de fato pago ou recebido. Se o vencimento já
 * passou — o caso de quem está preenchendo meses antigos — a resposta certa é
 * a própria data prevista: marcar "hoje" jogaria o pagamento para fora do mês.
 */
export const settlementDateFor = (dueDate: string, today = todayIso()) =>
  isPastDate(dueDate, today) ? dueDate : today;

export const monthRange = (month: string): { start: string; end: string } => {
  const [year, rawMonth] = month.split('-').map(Number);
  const start = `${year}-${String(rawMonth).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(year, rawMonth, 1));
  const end = next.toISOString().slice(0, 10);
  return { start, end };
};

export const dateForMonthDay = (month: string, day: number): string => {
  const [year, rawMonth] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, rawMonth, 0)).getUTCDate();
  return `${month}-${String(Math.min(Math.max(day, 1), lastDay)).padStart(2, '0')}`;
};

export const addMonths = (date: string, count: number): string => {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + count, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
};

/**
 * Próximo vencimento do cartão a partir de uma data de referência. Sem o
 * dia de fechamento, a regra mais previsível é nunca sugerir uma data passada.
 */
export const nextCardDueDate = (referenceDate: string, dueDay: number): string => {
  const month = referenceDate.slice(0, 7);
  const inCurrentMonth = dateForMonthDay(month, dueDay);
  if (inCurrentMonth >= referenceDate) return inCurrentMonth;
  return dateForMonthDay(addMonths(referenceDate, 1).slice(0, 7), dueDay);
};

/**
 * Vencimento da fatura que recebe uma compra.
 *
 * Antes do dia do fechamento, a compra entra na fatura que está fechando; no
 * próprio fechamento ou depois dele, entra na seguinte. Quando o vencimento fica antes do fechamento no
 * calendário (por exemplo, fecha 25 e vence 5), ele naturalmente cai no mês
 * posterior.
 */
export const cardStatementDueDate = (
  purchaseDate: string,
  closingDay: number,
  dueDay: number,
): string => {
  const purchaseMonth = purchaseDate.slice(0, 7);
  const closingDate = dateForMonthDay(purchaseMonth, closingDay);
  const dueAfterClosing = dueDay > closingDay;
  const purchaseAfterClosing = purchaseDate >= closingDate;
  const monthOffset = (dueAfterClosing ? 0 : 1) + (purchaseAfterClosing ? 1 : 0);
  const dueMonth = addMonths(`${purchaseMonth}-01`, monthOffset).slice(0, 7);
  return dateForMonthDay(dueMonth, dueDay);
};

export const calculateGoal = (
  targetAmount: number,
  savedAmount: number,
  dueDate: string | null,
  today = new Date(),
) => {
  const remainingAmount = Math.max(0, targetAmount - savedAmount);
  const progress = targetAmount > 0 ? Math.min(1, savedAmount / targetAmount) : 0;
  let suggestedMonthlyAmount: number | null = null;

  if (dueDate && remainingAmount > 0) {
    const due = new Date(`${dueDate}T12:00:00`);
    const months = Math.max(
      1,
      (due.getFullYear() - today.getFullYear()) * 12 +
        due.getMonth() -
        today.getMonth() +
        1,
    );
    suggestedMonthlyAmount = remainingAmount / months;
  }

  return { remainingAmount, progress, suggestedMonthlyAmount };
};

export const emptyMonthSummary = (month: string): MonthSummary => ({
  month,
  plannedIncome: 0,
  receivedIncome: 0,
  plannedExpenses: 0,
  paidExpenses: 0,
  overdueExpenses: 0,
  projectedBalance: 0,
  realizedBalance: 0,
  committedPercent: 0,
});
