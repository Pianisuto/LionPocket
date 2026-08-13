import type { MonthSummary } from './types';

export const toCents = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 100);
};

export const fromCents = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  return value / 100;
};

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
  projectedBalance: 0,
  realizedBalance: 0,
  committedPercent: 0,
});

