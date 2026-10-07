import { describe, expect, it } from 'vitest';
import { monthlyPlanningBalance, safetyMarginToCents, validateMonthlyPlanning } from './monthly-planning';

describe('monthly safety margin', () => {
  it.each([['2026-00', 1], ['2026-13', 1], ['26-10', 1], ['2026-10', -1], ['2026-10', 0.5], ['2026-10', NaN], ['2026-10', Infinity], ['2026-10', Number.MAX_SAFE_INTEGER + 1]])('rejects invalid month/cents %s %s', (month, cents) => {
    expect(() => validateMonthlyPlanning({ month: String(month), safetyMarginCents: Number(cents) })).toThrow();
  });
  it('uses cents, preserves the original projection and allows negative availability', () => {
    expect(monthlyPlanningBalance(3200, { month: '2026-10', safetyMarginCents: 50000 })).toEqual({ projectedBalance: 3200, safetyMargin: 500, balanceAfterSafetyMargin: 2700 });
    expect(monthlyPlanningBalance(300, { month: '2026-10', safetyMarginCents: 50000 }).balanceAfterSafetyMargin).toBe(-200);
    expect(monthlyPlanningBalance(0.3, { month: '2026-10', safetyMarginCents: 10 }).balanceAfterSafetyMargin).toBe(0.2);
  });
  it('zero and absence leave the projection available', () => {
    expect(monthlyPlanningBalance(12.34)).toEqual({ projectedBalance: 12.34, safetyMargin: 0, balanceAfterSafetyMargin: 12.34 });
    expect(monthlyPlanningBalance(-5, { month: '2026-10', safetyMarginCents: 0 })).toEqual(monthlyPlanningBalance(-5));
  });
  it('normalizes decimal money using the existing cents boundary and rejects invalid values', () => {
    expect(safetyMarginToCents(12.34)).toBe(1234);
    expect(safetyMarginToCents(0.1 + 0.2)).toBe(30);
    for (const value of [-0.001, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => safetyMarginToCents(value)).toThrow();
  });
});
