import { emptyMonthSummary, fromCents, toCents, todayIso } from './finance';
import { expenseCountsInMonth } from './transactions';
import type { Catalogs, MonthSummary, Transaction, TransactionInput } from './types';

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

export function validateMonth(month: string): void {
  if (!isValidDate(`${month}-01`)) throw new Error('Informe um mês válido.');
}

/** Mesma seleção mensal do desktop: vencimentos, atrasos e pagamentos tardios. */
export function transactionVisibleInMonth(item: Transaction, month: string): boolean {
  return (
    item.dueDate.slice(0, 7) === month ||
    (item.kind === 'expense' &&
      item.status === 'planned' &&
      item.isOverdue &&
      item.dueDate.slice(0, 7) < month) ||
    (item.kind === 'expense' &&
      item.status === 'paid' &&
      (item.settledDate ?? item.dueDate).slice(0, 7) === month)
  );
}

/** Resumo do desktop em centavos; receitas seguem o vencimento, despesas a competência. */
export function summarizeMonth(
  items: Transaction[],
  month: string,
  today = todayIso(),
): MonthSummary {
  validateMonth(month);
  const summary = emptyMonthSummary(month);
  for (const item of items) {
    if (!transactionVisibleInMonth(item, month) || item.status === 'cancelled') continue;
    const planned = toCents(item.plannedAmount) ?? 0;
    const actual = toCents(item.actualAmount ?? item.plannedAmount) ?? 0;
    if (item.kind === 'income') {
      summary.plannedIncome += planned;
      if (item.status === 'received') summary.receivedIncome += actual;
    } else {
      if (!expenseCountsInMonth(item, month, today.slice(0, 7))) continue;
      summary.plannedExpenses += planned;
      if (item.status === 'paid') summary.paidExpenses += actual;
      if (item.isOverdue) summary.overdueExpenses += planned;
    }
  }
  summary.plannedIncome = fromCents(summary.plannedIncome) ?? 0;
  summary.receivedIncome = fromCents(summary.receivedIncome) ?? 0;
  summary.plannedExpenses = fromCents(summary.plannedExpenses) ?? 0;
  summary.paidExpenses = fromCents(summary.paidExpenses) ?? 0;
  summary.overdueExpenses = fromCents(summary.overdueExpenses) ?? 0;
  summary.projectedBalance =
    fromCents((toCents(summary.plannedIncome) ?? 0) - (toCents(summary.plannedExpenses) ?? 0)) ?? 0;
  summary.realizedBalance =
    fromCents((toCents(summary.receivedIncome) ?? 0) - (toCents(summary.paidExpenses) ?? 0)) ?? 0;
  summary.committedPercent =
    summary.plannedIncome > 0 ? summary.plannedExpenses / summary.plannedIncome : 0;
  return summary;
}

export function validateTransaction(input: TransactionInput, catalogs?: Catalogs): void {
  if (!['income', 'expense'].includes(input.kind)) throw new Error('Tipo de lançamento inválido.');
  if (!input.description.trim()) throw new Error('Informe uma descrição.');
  const validAmount = (value: number, allowZero = false) =>
    Number.isFinite(value) &&
    Number.isSafeInteger(toCents(value)) &&
    (allowZero ? (toCents(value) ?? -1) >= 0 : (toCents(value) ?? 0) > 0);
  if (!validAmount(input.plannedAmount, true))
    throw new Error('Informe um valor planejado igual ou maior que zero.');
  if (input.actualAmount != null && !validAmount(input.actualAmount, true))
    throw new Error('Informe um valor realizado igual ou maior que zero.');
  if (!isValidDate(input.dueDate))
    throw new Error('Informe uma data prevista válida (AAAA-MM-DD).');
  if (input.purchaseDate && !isValidDate(input.purchaseDate))
    throw new Error('Informe uma data da compra válida.');
  const settled = input.status === 'paid' || input.status === 'received';
  if (
    !['planned', 'paid', 'received', 'cancelled'].includes(input.status) ||
    (input.status === 'paid' && input.kind !== 'expense') ||
    (input.status === 'received' && input.kind !== 'income')
  )
    throw new Error('Situação incompatível com o tipo do lançamento.');
  if (settled && (!input.settledDate || !isValidDate(input.settledDate)))
    throw new Error('Informe uma data de pagamento ou recebimento válida.');
  if (!settled && input.settledDate)
    throw new Error('Lançamentos pendentes ou cancelados não têm data de realização.');
  if (input.cardId && input.kind !== 'expense')
    throw new Error('Cartões só podem ser associados a saídas.');
  if (catalogs) {
    if (
      input.categoryId &&
      !catalogs.categories.some((c) => c.id === input.categoryId && c.kind === input.kind)
    )
      throw new Error('Escolha uma categoria compatível com o tipo.');
    if (
      input.paymentMethodId &&
      !catalogs.paymentMethods.some((p) => p.id === input.paymentMethodId)
    )
      throw new Error('Forma de pagamento não encontrada.');
    if (input.cardId && !catalogs.cards.some((c) => c.id === input.cardId))
      throw new Error('Cartão não encontrado.');
  }
}
