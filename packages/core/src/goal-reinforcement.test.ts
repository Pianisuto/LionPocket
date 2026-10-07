import { describe, expect, it } from 'vitest';
import { calculateGoal } from './finance';
import {
  assertGoalReinforcementAllowed,
  goalReinforcementAction,
  goalReinforcementNote,
  goalReinforcementPlan,
  goalReinforcementToCents,
  suggestionToReinforcementCents,
  totalGoalReinforcementForMonth,
  validateGoalReinforcement,
} from './goal-reinforcement';
import type { GoalMonthlyReinforcement, GoalStatus } from './types';

const goal = (id: string, status: GoalStatus) => ({ id, status });
const reinforcement = (goalId: string, month: string, amountCents: number): GoalMonthlyReinforcement => ({ goalId, month, amountCents });

describe('goal monthly reinforcement', () => {
  it.each([['g', '2026-00', 1], ['g', '2026-13', 1], ['g', '26-10', 1], ['g', '2026-10', -1], ['g', '2026-10', 0.5], ['g', '2026-10', NaN], ['g', '2026-10', Number.MAX_SAFE_INTEGER + 1], ['', '2026-10', 1]])(
    'rejects invalid goal/month/cents %s %s %s',
    (goalId, month, cents) => {
      expect(() => validateGoalReinforcement({ goalId, month, amountCents: Number(cents) })).toThrow();
    },
  );
  it('accepts zero and exact cents, normalizing decimal form values', () => {
    expect(() => validateGoalReinforcement(reinforcement('g', '2026-10', 0))).not.toThrow();
    expect(goalReinforcementToCents(500)).toBe(50000);
    expect(goalReinforcementToCents(0.1 + 0.2)).toBe(30);
    for (const value of [-0.001, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => goalReinforcementToCents(value)).toThrow();
  });

  it('keeps months independent and sums several goals in the same month', () => {
    const goals = [goal('notebook', 'saving'), goal('trip', 'planned')];
    const rows = [
      reinforcement('notebook', '2026-10', 50000),
      reinforcement('notebook', '2026-11', 70000),
      reinforcement('trip', '2026-10', 12345),
    ];
    expect(totalGoalReinforcementForMonth(goals, rows, '2026-10')).toBe(62345);
    expect(totalGoalReinforcementForMonth(goals, rows, '2026-11')).toBe(70000);
    expect(totalGoalReinforcementForMonth(goals, rows, '2026-12')).toBe(0);
    expect(goalReinforcementPlan(goals, rows, '2026-10').items.map((item) => item.amountCents)).toEqual([50000, 12345]);
  });

  it('counts only planned/saving goals; paused keeps its value without being protected', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => reinforcement(id, '2026-10', 1000));
    const goals = [goal('a', 'planned'), goal('b', 'saving'), goal('c', 'paused'), goal('d', 'completed'), goal('e', 'cancelled')];
    const plan = goalReinforcementPlan(goals, rows, '2026-10');
    expect(plan.totalCents).toBe(2000);
    expect(plan.items.map((item) => [item.goalId, item.counted, item.editable, item.amountCents])).toEqual([
      ['a', true, true, 1000], ['b', true, true, 1000], ['c', false, false, 1000], ['d', false, false, 1000], ['e', false, false, 1000],
    ]);
  });

  it('never counts a reinforcement whose goal no longer exists', () => {
    const rows = [reinforcement('gone', '2026-10', 99999), reinforcement('kept', '2026-10', 100)];
    expect(totalGoalReinforcementForMonth([goal('kept', 'saving')], rows, '2026-10')).toBe(100);
    expect(totalGoalReinforcementForMonth([], rows, '2026-10')).toBe(0);
  });

  it('allows definitions only for active goals but always allows removal', () => {
    for (const status of ['planned', 'saving'] as const) expect(() => assertGoalReinforcementAllowed(status, 100)).not.toThrow();
    for (const status of ['paused', 'completed', 'cancelled'] as const) {
      expect(() => assertGoalReinforcementAllowed(status, 100)).toThrow();
      expect(() => assertGoalReinforcementAllowed(status, 0)).not.toThrow();
    }
  });

  it('offers define/edit only to active goals and remove-only to the others', () => {
    const rows = ['a', 'b', 'c'].map((id) => reinforcement(id, '2026-10', 100));
    const goals = [goal('a', 'saving'), goal('b', 'paused'), goal('c', 'completed'), goal('d', 'cancelled'), goal('e', 'planned')];
    const items = goalReinforcementPlan(goals, rows, '2026-10').items;
    expect(items.map(goalReinforcementAction)).toEqual(['edit', 'remove', 'remove', null, 'define']);
    expect(items.map(goalReinforcementNote)).toEqual([null, expect.stringContaining('pausado'), expect.stringContaining('encerrado'), null, null]);
  });

  it('keeps the automatic suggestion separate from the explicit reinforcement', () => {
    const goalProgress = calculateGoal(1000, 100, '2027-02-10', new Date('2026-10-07T12:00:00'));
    const suggestion = suggestionToReinforcementCents(goalProgress.suggestedMonthlyAmount);
    expect(suggestion).toBe(18000);
    // A suggestion alone never produces a stored amount.
    expect(totalGoalReinforcementForMonth([goal('g', 'saving')], [], '2026-10')).toBe(0);
    expect(suggestionToReinforcementCents(null)).toBeNull();
    expect(suggestionToReinforcementCents(0)).toBeNull();
    expect(suggestionToReinforcementCents(233.333)).toBe(23333);
  });

  it('does not touch the calculated goal progress', () => {
    const before = calculateGoal(1000, 250, '2027-02-10', new Date('2026-10-07T12:00:00'));
    goalReinforcementPlan([goal('g', 'saving')], [reinforcement('g', '2026-10', 50000)], '2026-10');
    expect(calculateGoal(1000, 250, '2027-02-10', new Date('2026-10-07T12:00:00'))).toEqual(before);
  });
});
