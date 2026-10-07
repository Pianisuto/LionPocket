import type { MonthlyPlanningBalance } from '@lionpocket/core';
const money = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

export function safetyMarginHint(planning?: MonthlyPlanningBalance | null): string | null {
  return planning && planning.safetyMargin > 0
    ? `${money(planning.balanceAfterSafetyMargin)} após margem de segurança`
    : null;
}
