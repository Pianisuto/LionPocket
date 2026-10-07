import { validateMonth } from './daily-finance';
import { toCents } from './finance';
import type {
  Goal,
  GoalMonthlyReinforcement,
  GoalReinforcementItem,
  GoalReinforcementPlan,
  GoalStatus,
} from './types';

const invalidAmount = 'Informe um reforço válido, igual ou maior que zero.';

export function validateGoalReinforcement(input: GoalMonthlyReinforcement): void {
  if (typeof input.goalId !== 'string' || !input.goalId.trim())
    throw new Error('Informe o objetivo do reforço.');
  validateMonth(input.month);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0)
    throw new Error(invalidAmount);
}

/** Converts the platforms' decimal form values at the domain boundary. */
export function goalReinforcementToCents(value: number): number {
  const cents = toCents(value);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents))
    throw new Error(invalidAmount);
  return cents as number;
}

/** Planned and saving goals hold money "protected" for the month. */
export function goalCountsReinforcement(status: GoalStatus): boolean {
  return status === 'planned' || status === 'saving';
}

/**
 * Setting or raising a reinforcement needs an active goal. Removing (zero) is always
 * allowed so paused/completed/cancelled goals can be cleaned without losing history.
 */
export function assertGoalReinforcementAllowed(status: GoalStatus, amountCents: number): void {
  if (amountCents > 0 && !goalCountsReinforcement(status))
    throw new Error(
      status === 'paused'
        ? 'Retome o objetivo para definir um reforço mensal.'
        : 'Este objetivo não aceita novo reforço mensal.',
    );
}

/**
 * Per-goal view of one month, plus the total of what is currently protected.
 * Reinforcements of goals that no longer exist (deleted, or not yet received by sync)
 * are never counted, so a removed goal cannot leave a phantom amount behind.
 */
export function goalReinforcementPlan(
  goals: Pick<Goal, 'id' | 'status'>[],
  reinforcements: GoalMonthlyReinforcement[],
  month: string,
): GoalReinforcementPlan {
  validateMonth(month);
  const amounts = new Map<string, number>();
  for (const item of reinforcements) {
    if (item.month !== month) continue;
    validateGoalReinforcement(item);
    amounts.set(item.goalId, item.amountCents);
  }
  let totalCents = 0;
  const items = goals.map((goal) => {
    const amountCents = amounts.get(goal.id) ?? 0;
    const counted = goalCountsReinforcement(goal.status);
    if (counted) totalCents += amountCents;
    if (!Number.isSafeInteger(totalCents)) throw new Error(invalidAmount);
    return { goalId: goal.id, status: goal.status, amountCents, counted, editable: counted };
  });
  return { month, totalCents, items };
}

/** Total reserved for goals in a month, in cents; ready for a future "Livre agora". */
export function totalGoalReinforcementForMonth(
  goals: Pick<Goal, 'id' | 'status'>[],
  reinforcements: GoalMonthlyReinforcement[],
  month: string,
): number {
  return goalReinforcementPlan(goals, reinforcements, month).totalCents;
}

/** Explicit "Usar sugestão": the amount is offered to the user, never stored silently. */
export function suggestionToReinforcementCents(suggestedMonthlyAmount: number | null): number | null {
  if (suggestedMonthlyAmount === null || !Number.isFinite(suggestedMonthlyAmount) || suggestedMonthlyAmount <= 0)
    return null;
  const cents = toCents(suggestedMonthlyAmount);
  return cents !== null && Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export type GoalReinforcementAction = 'define' | 'edit' | 'remove' | null;

/** Active goals can define/edit; other goals can only drop a reinforcement they still hold. */
export function goalReinforcementAction(item: GoalReinforcementItem): GoalReinforcementAction {
  if (item.editable) return item.amountCents > 0 ? 'edit' : 'define';
  return item.amountCents > 0 ? 'remove' : null;
}

/** Why a stored reinforcement is not counted as protected money, shared by both platforms. */
export function goalReinforcementNote(item: GoalReinforcementItem): string | null {
  if (item.counted || item.amountCents === 0) return null;
  return item.status === 'paused'
    ? 'Objetivo pausado: o valor fica no histórico e não conta como protegido.'
    : 'Objetivo encerrado: o valor não conta como protegido.';
}
