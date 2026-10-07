import { toCents } from './finance';
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
 * Livre agora = o ponto mais baixo do saldo até o fim do mês − dinheiro protegido.
 *
 * É uma simulação dia a dia, sem saldo bancário: o LionPocket só conhece o "Saldo realizado"
 * do mês (recebido − pago, `summarizeMonth`, o mesmo número dos cards), que é o ponto de
 * partida ("em mãos"). A partir de hoje, cada conta ainda pendente sai na sua data e cada
 * entrada ainda prevista chega na sua. O menor saldo desse caminho é quanto dá para gastar
 * agora sem que o saldo fique negativo em nenhum dia do mês; o dinheiro protegido sai disso.
 *
 * - Despesas `planned` do mês (inclusive atrasos carregados, que saem hoje). Pagas, recebidas
 *   e canceladas não entram, nem valores zerados. Faturas, parcelas e recorrências já são
 *   lançamentos com vencimento calculado e contam uma vez, pela própria data.
 * - Entradas `planned` com data de hoje em diante. Entrada atrasada não conta: não se conta
 *   com dinheiro que não chegou.
 * - No mesmo dia, as contas saem **antes** das entradas (regra conservadora e determinística):
 *   não há garantia de que o dinheiro chegue antes do vencimento.
 * - O período é o mês consultado; o que vence em outro mês não entra.
 * - O resultado não é limitado a zero. Só existe para o mês atual; para outros devolve `null`.
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

  type Event = { date: string; income: boolean; cents: number };
  const events: Event[] = [];
  for (const item of items) {
    const cents = toCents(item.plannedAmount) ?? 0;
    if (item.status !== 'planned' || cents <= 0) continue;
    if (item.kind === 'income') {
      if (item.dueDate.slice(0, 7) === month && item.dueDate >= today)
        events.push({ date: item.dueDate, income: true, cents });
    } else if (expenseCountsInMonth(item, month, today.slice(0, 7))) {
      events.push({ date: item.dueDate < today ? today : item.dueDate, income: false, cents });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || Number(a.income) - Number(b.income));

  let balance = realizedBalanceCents;
  let expenses = 0;
  let incomes = 0;
  let lowest = { cents: balance, date: today, expenses: 0, incomes: 0 };
  for (const event of events) {
    if (event.income) incomes = safe(incomes + event.cents);
    else expenses = safe(expenses + event.cents);
    balance = safe(balance + (event.income ? event.cents : -event.cents));
    if (balance < lowest.cents) lowest = { cents: balance, date: event.date, expenses, incomes };
  }
  return {
    ...protectedAmount,
    today,
    realizedBalanceCents,
    nextIncome,
    lowestPointCents: lowest.cents,
    lowestPointDate: lowest.date,
    commitmentsUntilLowestPointCents: lowest.expenses,
    incomesUntilLowestPointCents: lowest.incomes,
    freeNowCents: safe(lowest.cents - protectedAmount.protectedMoneyCents),
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
  key: 'realized' | 'commitments' | 'incomes' | 'safetyMargin' | 'goals';
  label: string;
  /** Signed contribution to "Livre agora": positive adds, negative subtracts. */
  cents: number;
}

/** Breakdown rows shared by both platforms; lines at zero are left out, except the starting balance. */
export function freeNowComposition(freeNow: FreeNow): FreeNowLine[] {
  const until = freeNow.lowestPointDate === freeNow.today ? 'hoje' : shortDate(freeNow.lowestPointDate);
  const lines: FreeNowLine[] = [
    { key: 'realized', label: 'Em mãos (recebido − pago no mês)', cents: freeNow.realizedBalanceCents },
  ];
  if (freeNow.commitmentsUntilLowestPointCents > 0)
    lines.push({
      key: 'commitments',
      label: `Contas até ${until}`,
      cents: -freeNow.commitmentsUntilLowestPointCents,
    });
  if (freeNow.incomesUntilLowestPointCents > 0)
    lines.push({
      key: 'incomes',
      label: `Entradas previstas até ${until}`,
      cents: freeNow.incomesUntilLowestPointCents,
    });
  if (freeNow.safetyMarginCents > 0)
    lines.push({ key: 'safetyMargin', label: 'Margem de segurança', cents: -freeNow.safetyMarginCents });
  if (freeNow.goalReinforcementCents > 0)
    lines.push({ key: 'goals', label: 'Objetivos', cents: -freeNow.goalReinforcementCents });
  return lines;
}

/** Where the month is tightest, in words. */
export function freeNowHorizon(freeNow: FreeNow): string {
  if (freeNow.lowestPointDate === freeNow.today)
    return 'O saldo do mês fica mais apertado hoje; depois disso ele só se recupera.';
  return `O saldo do mês fica mais apertado em ${shortDate(freeNow.lowestPointDate)}.`;
}
