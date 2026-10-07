import { dateForMonthDay, toCents } from './finance';
import { isValidDate, summarizeMonth, validateMonth } from './daily-finance';
import { goalReinforcementPlan } from './goal-reinforcement';
import { validateMonthlyPlanning } from './monthly-planning';
import { expenseCountsInMonth } from './transactions';
import type {
  FreeNow,
  Goal,
  GoalMonthlyReinforcement,
  MonthlyPlanning,
  NextIncome,
  ProtectedMoney,
  ProtectionBalance,
  Transaction,
} from './types';

const unsafeAmount = 'Os valores do planejamento excedem o limite suportado.';

const safe = (cents: number): number => {
  if (!Number.isSafeInteger(cents)) throw new Error(unsafeAmount);
  return cents;
};

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl = (cents: number) => money.format(cents / 100);
const shortDate = (date: string) => date.slice(5).split('-').reverse().join('/');

/**
 * Dinheiro protegido do mês = margem de segurança + reforços ativos dos objetivos.
 * É sempre derivado: margem e reforços são as únicas fontes persistidas e nada carrega
 * de um mês para o outro. Reforço de objetivo pausado/concluído/cancelado ou removido
 * não conta (mesma regra de `goalReinforcementPlan`). Não é despesa nem movimentação.
 */
export function protectedMoney(
  planning: MonthlyPlanning | null | undefined,
  goals: Pick<Goal, 'id' | 'status'>[],
  reinforcements: GoalMonthlyReinforcement[],
  month: string,
): ProtectedMoney {
  validateMonth(month);
  if (planning) validateMonthlyPlanning(planning);
  const safetyMarginCents = planning && planning.month === month ? planning.safetyMarginCents : 0;
  const goalReinforcementCents = goalReinforcementPlan(goals, reinforcements, month).totalCents;
  return {
    month,
    safetyMarginCents,
    goalReinforcementCents,
    protectedMoneyCents: safe(safetyMarginCents + goalReinforcementCents),
  };
}

/** Saldo projetado menos o dinheiro protegido; negativo é uma informação válida. */
export function protectionBalance(projectedBalance: number, protectedAmount: ProtectedMoney): ProtectionBalance {
  const projectedBalanceCents = toCents(projectedBalance) ?? 0;
  return {
    ...protectedAmount,
    projectedBalanceCents,
    balanceAfterProtectionCents: safe(projectedBalanceCents - protectedAmount.protectedMoneyCents),
  };
}

/**
 * Primeira data, a partir de hoje, com receita ainda prevista no mês. Receita recebida ou
 * cancelada nunca conta; receita prevista com data já passada está atrasada e também não
 * serve de âncora (não se conta com dinheiro que não chegou). Várias entradas no mesmo
 * dia são somadas.
 */
export function nextIncomeOf(items: Transaction[], month: string, today: string): NextIncome | null {
  const pending = items
    .filter(
      (item) =>
        item.kind === 'income' &&
        item.status === 'planned' &&
        item.plannedAmount > 0 &&
        item.dueDate.slice(0, 7) === month &&
        item.dueDate >= today,
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (!pending.length) return null;
  const date = pending[0].dueDate;
  const sameDay = pending.filter((item) => item.dueDate === date);
  const [first] = [...sameDay].sort(
    (a, b) => a.description.localeCompare(b.description, 'pt-BR') || a.id.localeCompare(b.id),
  );
  return {
    date,
    amountCents: safe(sameDay.reduce((sum, item) => sum + (toCents(item.plannedAmount) ?? 0), 0)),
    count: sameDay.length,
    description: sameDay.length === 1 ? first.description : null,
  };
}

/**
 * Livre agora = saldo realizado do mês − compromissos até a próxima entrada − dinheiro protegido.
 *
 * - Saldo disponível: o LionPocket não tem saldo bancário, então a única fonte canônica é o
 *   "Saldo realizado" do mês (recebido − pago, `summarizeMonth`), o mesmo número dos cards.
 * - Compromissos: despesas ainda pendentes (`planned`) do mês, incluindo atrasos carregados,
 *   que vencem até a data da próxima entrada, **inclusive**: uma conta que vence no dia da
 *   entrada conta antes dela, pois não há garantia de que o dinheiro chegue antes do vencimento.
 *   Sem outra entrada prevista, valem todas as pendências até o fim do mês.
 * - Pagas, recebidas e canceladas não entram. Faturas, parcelas e recorrências já são
 *   lançamentos com vencimento calculado e entram pela própria data.
 * - O resultado não é limitado a zero.
 *
 * Só existe para o mês atual; para outros meses devolve `null`.
 */
export function calculateFreeNow(
  items: Transaction[],
  month: string,
  today: string,
  planning: MonthlyPlanning | null | undefined,
  goals: Pick<Goal, 'id' | 'status'>[],
  reinforcements: GoalMonthlyReinforcement[],
): FreeNow | null {
  validateMonth(month);
  if (!isValidDate(today)) throw new Error('Informe uma data válida.');
  if (today.slice(0, 7) !== month) return null;
  const protectedAmount = protectedMoney(planning, goals, reinforcements, month);
  const realizedBalanceCents = toCents(summarizeMonth(items, month, today).realizedBalance) ?? 0;
  const nextIncome = nextIncomeOf(items, month, today);
  const commitmentsUntil = nextIncome?.date ?? dateForMonthDay(month, 31);
  const commitmentsBeforeNextIncomeCents = safe(
    items
      .filter(
        (item) =>
          item.kind === 'expense' &&
          item.status === 'planned' &&
          item.plannedAmount > 0 &&
          item.dueDate <= commitmentsUntil &&
          expenseCountsInMonth(item, month, today.slice(0, 7)),
      )
      .reduce((sum, item) => sum + (toCents(item.plannedAmount) ?? 0), 0),
  );
  return {
    ...protectedAmount,
    today,
    realizedBalanceCents,
    nextIncome,
    commitmentsUntil,
    commitmentsBeforeNextIncomeCents,
    freeNowCents: safe(
      realizedBalanceCents - commitmentsBeforeNextIncomeCents - protectedAmount.protectedMoneyCents,
    ),
  };
}

/** Everything the Dashboard needs, computed once so both platforms show identical numbers. */
export function monthlyProtectionOverview(
  items: Transaction[],
  goals: Pick<Goal, 'id' | 'status'>[],
  reinforcements: GoalMonthlyReinforcement[],
  planning: MonthlyPlanning | null | undefined,
  month: string,
  today: string,
  projectedBalance: number,
): { protection: ProtectionBalance; freeNow: FreeNow | null } {
  return {
    protection: protectionBalance(projectedBalance, protectedMoney(planning, goals, reinforcements, month)),
    freeNow: calculateFreeNow(items, month, today, planning, goals, reinforcements),
  };
}

/** Auxiliary line for the "Saldo projetado" card; null keeps the original wording. */
export function protectionHint(protection?: ProtectionBalance | null): string | null {
  if (!protection || protection.protectedMoneyCents <= 0) return null;
  const what =
    protection.goalReinforcementCents === 0
      ? 'margem de segurança'
      : protection.safetyMarginCents === 0
        ? 'reforços dos objetivos'
        : 'proteções';
  return `${brl(protection.balanceAfterProtectionCents)} após ${what}`;
}

export interface FreeNowLine {
  key: 'realized' | 'commitments' | 'safetyMargin' | 'goals';
  label: string;
  /** Signed contribution to "Livre agora": positive adds, negative subtracts. */
  cents: number;
}

/** Breakdown rows shared by both platforms; protections at zero are left out. */
export function freeNowComposition(freeNow: FreeNow): FreeNowLine[] {
  const lines: FreeNowLine[] = [
    { key: 'realized', label: 'Saldo realizado do mês', cents: freeNow.realizedBalanceCents },
    {
      key: 'commitments',
      label: freeNow.nextIncome ? 'Contas antes da próxima entrada' : 'Contas até o fim do mês',
      cents: -freeNow.commitmentsBeforeNextIncomeCents,
    },
  ];
  if (freeNow.safetyMarginCents > 0)
    lines.push({ key: 'safetyMargin', label: 'Margem de segurança', cents: -freeNow.safetyMarginCents });
  if (freeNow.goalReinforcementCents > 0)
    lines.push({ key: 'goals', label: 'Objetivos', cents: -freeNow.goalReinforcementCents });
  return lines;
}

/** Which period the commitments cover, in words. */
export function freeNowHorizon(freeNow: FreeNow): string {
  const { nextIncome } = freeNow;
  if (!nextIncome) return 'Sem outra entrada prevista: considera as contas até o fim do mês.';
  const what = nextIncome.description ?? `${nextIncome.count} entradas`;
  return `Até a próxima entrada: ${what}, em ${shortDate(nextIncome.date)}.`;
}
