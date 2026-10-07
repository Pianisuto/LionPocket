import { validateMonth } from './daily-finance';
import { fromCents, toCents } from './finance';
import type { MonthlyPlanning, MonthlyPlanningBalance } from './types';

export function validateMonthlyPlanning(input: MonthlyPlanning): void {
  validateMonth(input.month);
  if (!Number.isSafeInteger(input.safetyMarginCents) || input.safetyMarginCents < 0)
    throw new Error('Informe uma margem de segurança válida, igual ou maior que zero.');
}

/** Converts the platforms' decimal form values at the domain boundary. */
export function safetyMarginToCents(value: number): number {
  const cents = toCents(value);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents))
    throw new Error('Informe uma margem de segurança válida, igual ou maior que zero.');
  return cents as number;
}

export function monthlyPlanningBalance(
  projectedBalance: number,
  planning?: MonthlyPlanning | null,
): MonthlyPlanningBalance {
  if (planning) validateMonthlyPlanning(planning);
  const margin = planning?.safetyMarginCents ?? 0;
  return {
    projectedBalance,
    safetyMargin: fromCents(margin) ?? 0,
    balanceAfterSafetyMargin: fromCents((toCents(projectedBalance) ?? 0) - margin) ?? 0,
  };
}
