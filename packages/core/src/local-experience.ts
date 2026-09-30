import { expenseCountsInMonth } from './transactions';
import { fromCents, toCents } from './finance';
import { isCreditCardTransaction } from './credit-cards';
import type {
  CategorySummary,
  Transaction,
  TransactionFilters,
  TransactionSuggestion,
} from './types';

export const normalizeSearchText = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');
export const monetarySearchDigits = (value: string) => {
  const cleaned = value.trim();
  return /^(?:r\$\s*)?[\d\s.,]+$/i.test(cleaned) ? cleaned.replace(/\D/g, '') || null : null;
};
export function filterTransactions(
  items: Transaction[],
  filters: Omit<TransactionFilters, 'month'> & { overdue?: boolean },
) {
  const term = normalizeSearchText(filters.search?.trim());
  const digits = monetarySearchDigits(filters.search ?? '');
  return items.filter(
    (item) =>
      (!filters.kind || filters.kind === 'all' || item.kind === filters.kind) &&
      (!filters.status || filters.status === 'all' || item.status === filters.status) &&
      (!filters.overdue || item.isOverdue) &&
      (!filters.source || filters.source === 'all' || item.sourceType === filters.source) &&
      (!filters.payment ||
        filters.payment === 'all' ||
        isCreditCardTransaction(item) === (filters.payment === 'creditCard')) &&
      (!term ||
        normalizeSearchText(
          [
            item.description,
            item.categoryName,
            item.paymentMethodName,
            item.cardName,
            item.notes,
          ].join(' '),
        ).includes(term) ||
        Boolean(
          digits && String(toCents(item.actualAmount ?? item.plannedAmount)).includes(digits),
        )),
  );
}
export type TransactionSort =
  | 'date'
  | 'description'
  | 'category'
  | 'paymentMethod'
  | 'card'
  | 'purchaseDate'
  | 'status'
  | 'amount';
export function orderedTransactions(
  items: Transaction[],
  key: TransactionSort = 'date',
  direction: 'asc' | 'desc' = 'asc',
  showPriorities = true,
) {
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  const labels = {
    planned: 'Planejado',
    paid: 'Pago',
    received: 'Recebido',
    cancelled: 'Cancelado',
  };
  const value = (t: Transaction) =>
    key === 'date'
      ? t.dueDate
      : key === 'purchaseDate'
        ? (t.purchaseDate ?? '')
        : key === 'description'
          ? t.description
          : key === 'category'
            ? (t.categoryName ?? 'Sem categoria')
            : key === 'paymentMethod'
              ? (t.paymentMethodName ?? 'Não informado')
              : key === 'card'
                ? (t.cardName ?? '')
                : labels[t.status];
  return [...items].sort((a, b) => {
    if (showPriorities && (a.priorityPosition !== null || b.priorityPosition !== null))
      return (
        (a.priorityPosition ?? Number.MAX_SAFE_INTEGER) -
        (b.priorityPosition ?? Number.MAX_SAFE_INTEGER)
      );
    if (key === 'purchaseDate' && Boolean(a.purchaseDate) !== Boolean(b.purchaseDate))
      return a.purchaseDate ? -1 : 1;
    const comparison =
      key === 'amount'
        ? (a.actualAmount ?? a.plannedAmount) - (b.actualAmount ?? b.plannedAmount)
        : collator.compare(value(a), value(b));
    return (
      (direction === 'asc' ? comparison : -comparison) ||
      collator.compare(a.description, b.description) ||
      a.id.localeCompare(b.id)
    );
  });
}
export interface RecurringPriority {
  recurringId: string;
  position: number;
  pinnedFromMonth: string;
}
export interface MonthlyPriority {
  transactionId: string;
  position: number;
}
/** Desktop rule: monthly snapshot first, then inherited recurring order. */
export function priorityOrderForMonth(
  month: string,
  items: Transaction[],
  recurring: RecurringPriority[],
  monthly: MonthlyPriority[],
) {
  const inherited = new Map(
    recurring.filter((r) => r.pinnedFromMonth <= month).map((r) => [r.recurringId, r.position]),
  );
  const snapshot = new Map(monthly.map((r) => [r.transactionId, r.position]));
  return items
    .filter((t) =>
      t.sourceType === 'recurring'
        ? Boolean(t.sourceId && inherited.has(t.sourceId))
        : snapshot.has(t.id),
    )
    .sort((a, b) => {
      const left = snapshot.get(a.id),
        right = snapshot.get(b.id);
      if (left !== undefined && right !== undefined && left !== right) return left - right;
      if (left !== undefined && right === undefined) return -1;
      if (left === undefined && right !== undefined) return 1;
      return (
        (inherited.get(a.sourceId ?? '') ?? Number.MAX_SAFE_INTEGER) -
          (inherited.get(b.sourceId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
        a.dueDate.localeCompare(b.dueDate) ||
        a.id.localeCompare(b.id)
      );
    })
    .map((t) => t.id);
}
export function historySuggestions(
  items: Transaction[],
  kind: Transaction['kind'],
  term: string,
  limit = 6,
): TransactionSuggestion[] {
  if (term.trim().length < 2) return [];
  const groups = new Map<string, { latest: Transaction; uses: number }>();
  for (const item of items) {
    if (
      item.kind !== kind ||
      item.status === 'cancelled' ||
      !item.description.toLocaleLowerCase('pt-BR').includes(term.trim().toLocaleLowerCase('pt-BR'))
    )
      continue;
    const key = item.description.toLocaleLowerCase('pt-BR');
    const group = groups.get(key);
    groups.set(key, {
      latest: !group || item.dueDate > group.latest.dueDate ? item : group.latest,
      uses: (group?.uses ?? 0) + 1,
    });
  }
  return [...groups.values()]
    .sort((a, b) => b.uses - a.uses || b.latest.dueDate.localeCompare(a.latest.dueDate))
    .slice(0, limit)
    .map(({ latest: t, uses }) => ({
      description: t.description,
      categoryId: t.categoryId,
      categoryName: t.categoryName,
      paymentMethodId: t.paymentMethodId,
      cardId: t.cardId,
      amount: t.actualAmount ?? t.plannedAmount,
      uses,
    }));
}
export function categoryBreakdown(items: Transaction[], month: string, today?: string): CategorySummary[] {
  const groups = new Map<string, CategorySummary>();
  for (const t of items) {
    if (!expenseCountsInMonth(t, month, today?.slice(0, 7))) continue;
    const key = t.categoryId ?? 'uncategorized';
    const group = groups.get(key) ?? {
      name: t.categoryName ?? 'Sem categoria',
      color: t.categoryColor ?? '#9C8AA5',
      amount: 0,
    };
    group.amount +=
      toCents(t.status === 'paid' ? (t.actualAmount ?? t.plannedAmount) : t.plannedAmount) ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map((g) => ({ ...g, amount: fromCents(g.amount) ?? 0 }));
}

/** Adjacent arrows move complete recurring groups, including filtered-out occurrences. */
export function priorityMoveAnchor(
  priorities: Transaction[],
  item: Transaction,
  direction: 'up' | 'down',
): { available: boolean; beforeTransactionId: string | null } {
  const sameGroup = (candidate: Transaction) =>
    item.sourceType === 'recurring' && item.sourceId
      ? candidate.sourceType === 'recurring' && candidate.sourceId === item.sourceId
      : candidate.id === item.id;
  const first = priorities.findIndex(sameGroup);
  if (first < 0) return { available: false, beforeTransactionId: null };
  const remaining = priorities.filter((candidate) => !sameGroup(candidate));
  if (direction === 'up')
    return {
      available: first > 0,
      beforeTransactionId: remaining[Math.max(0, first - 1)]?.id ?? null,
    };
  return {
    available: first < remaining.length,
    beforeTransactionId: remaining[first + 1]?.id ?? null,
  };
}
