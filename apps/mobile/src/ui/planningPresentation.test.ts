import { expect, it } from 'vitest';
import { monthlyPlanningBalance } from '@lionpocket/core';
import { safetyMarginHint } from './planningPresentation';
it('keeps both mobile balance cards unchanged without a margin', () => {
  expect(safetyMarginHint()).toBeNull();
  expect(safetyMarginHint(monthlyPlanningBalance(3200))).toBeNull();
  expect(safetyMarginHint(monthlyPlanningBalance(3200, { month: '2026-10', safetyMarginCents: 0 }))).toBeNull();
});
it('shows the auxiliary available amount, including a negative result, in pt-BR', () => {
  expect(safetyMarginHint(monthlyPlanningBalance(3200, { month: '2026-10', safetyMarginCents: 50000 }))).toMatch(/2\.700,00 após margem de segurança/);
  expect(safetyMarginHint(monthlyPlanningBalance(300, { month: '2026-10', safetyMarginCents: 50000 }))).toMatch(/-R\$.*200,00 após margem de segurança/);
});
