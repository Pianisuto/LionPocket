import { fromCents, settlementDateFor, toCents, todayIso } from '@lionpocket/core/finance';
import type { MoneyKind, TransactionInput } from '@lionpocket/core/types';

export function parseTransactionForm(
  kind: MoneyKind,
  description: string,
  amountText: string,
  dueDate: string,
  settled: boolean,
): TransactionInput {
  const name = description.trim();
  if (!name) throw new Error('Informe uma descrição.');
  if (!/^\d+([,.]\d{1,2})?$/.test(amountText.trim())) {
    throw new Error('Informe um valor válido, como 12,50.');
  }
  const cents = toCents(Number(amountText.trim().replace(',', '.')));
  if (cents === null || cents <= 0 || !Number.isSafeInteger(cents)) {
    throw new Error('Informe um valor válido maior que zero.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error('Use a data no formato AAAA-MM-DD.');
  }
  const [year, month, day] = dueDate.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== dueDate) {
    throw new Error('Informe uma data válida.');
  }
  const status = settled ? (kind === 'income' ? 'received' : 'paid') : 'planned';
  return {
    kind,
    description: name,
    plannedAmount: fromCents(cents) ?? 0,
    actualAmount: settled ? fromCents(cents) : null,
    dueDate,
    settledDate: settled ? settlementDateFor(dueDate, todayIso()) : null,
    status,
  };
}
