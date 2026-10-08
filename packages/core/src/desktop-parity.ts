import { monthlyPlanningBalance } from './monthly-planning';
import { monthlyProtectionOverview } from './free-now';
import type { GoalMonthlyReinforcement, MonthlyPlanning } from './types';
import { categoryBreakdown } from './local-experience';
import { summarizeMonth, isValidDate } from './daily-finance';
import { todayIso } from './finance';
import { expenseCountsInMonth } from './transactions';
import { groupCreditCardInvoices } from './credit-cards';
import type { Goal, MoneyKind, Transaction, TransactionStatus } from './types';

/** Desktop's automatic status, until the person explicitly chooses one. */
export function statusForDate(
  date: string,
  kind: MoneyKind,
  today = todayIso(),
): TransactionStatus {
  return isValidDate(date) && date < today
    ? kind === 'income'
      ? 'received'
      : 'paid'
    : 'planned';
}

/** Same monthly selections and limits as the desktop overview, without platform APIs. */
export function monthlyOverview(
  items: Transaction[],
  goals: Goal[],
  month: string,
  today = todayIso(),
  planning?: MonthlyPlanning | null,
  reinforcements: GoalMonthlyReinforcement[] = [],
) {
  const summary = summarizeMonth(items, month, today);
  const countedExpenses = items.filter(
    (t) =>
      t.kind === 'expense' &&
      t.status !== 'cancelled' &&
      expenseCountsInMonth(t, month, today.slice(0, 7)),
  );
  return {
    summary,
    planning: monthlyPlanningBalance(summary.projectedBalance, planning),
    ...monthlyProtectionOverview(items, goals, reinforcements, planning, month, today, summary.projectedBalance),
    categoryBreakdown: categoryBreakdown(items, month, today),
    upcoming: countedExpenses
      .filter((t) => t.status === 'planned' && t.plannedAmount > 0)
      .sort(
        (a, b) =>
          Number(b.isOverdue) - Number(a.isOverdue) ||
          a.dueDate.localeCompare(b.dueDate) ||
          a.description.localeCompare(b.description, 'pt-BR'),
      ),
    recent: items
      .filter(
        (t) =>
          (t.kind === 'income' ||
            expenseCountsInMonth(t, month, today.slice(0, 7))) &&
          (t.plannedAmount > 0 || (t.actualAmount ?? 0) > 0),
      )
      .sort((a, b) =>
        (b.settledDate ?? b.dueDate).localeCompare(a.settledDate ?? a.dueDate),
      )
      .slice(0, 6),
    goals: goals
      .filter((g) => !['cancelled', 'completed'].includes(g.status))
      .slice(0, 3),
  };
}

export function upcomingPayments(items: Transaction[]) {
  const invoices = groupCreditCardInvoices(items);
  const invoiceIds = new Set(invoices.flatMap((i) => i.items.map((t) => t.id)));
  return [
    ...invoices.map((invoice) => ({
      ...invoice,
      cardInvoice: true,
      detail: `${invoice.items.length} compra(s) na fatura`,
    })),
    ...items
      .filter((t) => !invoiceIds.has(t.id))
      .map((t) => ({
        key: `transaction:${t.id}`,
        name: t.description,
        dueDate: t.dueDate,
        total: t.plannedAmount,
        overdue: t.isOverdue,
        cardInvoice: false,
        items: [t],
        detail: t.categoryName ?? 'Sem categoria',
      })),
  ]
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        a.dueDate.localeCompare(b.dueDate) ||
        a.name.localeCompare(b.name, 'pt-BR'),
    )
    .slice(0, 5);
}

export type LeoMood =
  | 'neutral'
  | 'happy'
  | 'proud'
  | 'worried'
  | 'alarmed'
  | 'sleepy'
  | 'roar'
  | 'love'
  | 'eating';
export type LeoAccessory = 'none' | 'bow' | 'glasses' | 'crown' | 'party';
export type MonthlyOverview = ReturnType<typeof monthlyOverview>;
export function leoMood(overview: MonthlyOverview | null): LeoMood {
  if (!overview) return 'neutral';
  const s = overview.summary;
  if (s.plannedIncome === 0 && s.plannedExpenses === 0) return 'neutral';
  if (s.projectedBalance < 0) return 'alarmed';
  if (s.committedPercent > 0.85) return 'worried';
  if (s.plannedExpenses > 0 && s.paidExpenses >= s.plannedExpenses)
    return 'proud';
  return s.projectedBalance > 0 ? 'happy' : 'neutral';
}

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});
export function leoMessage(
  overview: MonthlyOverview | null,
  topic: 'month' | 'upcoming' | 'goals',
) {
  if (!overview) return 'Ainda estou abrindo as contas do mês…';
  if (topic === 'goals') {
    const closest = [...overview.goals].sort(
      (a, b) => b.progress - a.progress,
    )[0];
    return closest
      ? `“${closest.name}” está em ${Math.round(closest.progress * 100)}%. Faltam ${currency.format(Math.max(0, closest.targetAmount - closest.savedAmount))}.`
      : 'Você ainda não tem objetivos. Todo plano começa com um nome.';
  }
  if (topic === 'upcoming') {
    const next = overview.upcoming[0];
    if (!next) return 'Nenhuma conta em aberto neste mês. Aproveita o sossego.';
    const rest = overview.upcoming.length - 1;
    return `A próxima é ${next.description}: ${currency.format(next.plannedAmount)} em ${next.dueDate.split('-').reverse().join('/')}.${rest > 0 ? ` Depois dela vêm mais ${rest} no mês.` : ' E é a única do mês.'}`;
  }
  const s = overview.summary;
  if (s.plannedIncome === 0 && s.plannedExpenses === 0)
    return 'Este mês está em branco. Que tal lançar a primeira entrada?';
  const percent = Math.round(s.committedPercent * 100),
    top = overview.categoryBreakdown[0];
  const tail = top
    ? ` O maior peso é ${top.name}, com ${currency.format(top.amount)}.`
    : '';
  if (s.projectedBalance < 0)
    return `Cuidado: se tudo acontecer como está planejado, o mês fecha ${currency.format(Math.abs(s.projectedBalance))} no vermelho.${tail}`;
  return percent > 85
    ? `${percent}% do que entra já está comprometido. Sobra pouco: ${currency.format(s.projectedBalance)}.${tail}`
    : `O mês fecha com ${currency.format(s.projectedBalance)} de sobra e ${percent}% da renda comprometida.${tail}`;
}

/** Same external-link policy as desktop; platform decides how to open it. */
export function externalGoalUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Use um link http ou https.');
  return url.href;
}
