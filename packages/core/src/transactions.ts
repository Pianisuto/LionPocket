import type { Transaction } from './types';
import { currentMonthIso } from './finance';

/** A competência de uma despesa considera pagamentos e pendências carregadas adiante. */
export const expenseCountsInMonth = (transaction: Transaction, month: string) => {
  if (transaction.kind !== 'expense' || transaction.status === 'cancelled') return false;
  if (transaction.status === 'paid') {
    return (transaction.settledDate ?? transaction.dueDate).slice(0, 7) === month;
  }
  if (transaction.status !== 'planned') return transaction.dueDate.slice(0, 7) === month;
  const dueMonth = transaction.dueDate.slice(0, 7);
  if (dueMonth === month) {
    return !(transaction.isOverdue && month < currentMonthIso());
  }
  return transaction.isOverdue && dueMonth < month;
};

export const applyPriorityChange = (
  current: Transaction[],
  item: Transaction,
  pinned: boolean,
  beforeTransactionId: string | null,
) => {
  const movedIds = item.sourceType === 'recurring' && item.sourceId
    ? current
        .filter((candidate) => candidate.sourceType === 'recurring'
          && candidate.sourceId === item.sourceId)
        .map((candidate) => candidate.id)
    : [item.id];
  const movedSet = new Set(movedIds);
  const order = [...current]
    .filter((candidate) => candidate.priorityPosition !== null && !movedSet.has(candidate.id))
    .sort((left, right) => Number(left.priorityPosition) - Number(right.priorityPosition))
    .map((candidate) => candidate.id);
  if (pinned) {
    const anchor = beforeTransactionId ? order.indexOf(beforeTransactionId) : -1;
    order.splice(anchor >= 0 ? anchor : order.length, 0, ...movedIds);
  }
  const positions = new Map(order.map((id, position) => [id, position]));
  return current.map((candidate) => ({
    ...candidate,
    priorityPosition: positions.get(candidate.id) ?? null,
  }));
};
