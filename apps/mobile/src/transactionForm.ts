import { fromCents, settlementDateFor, toCents, validateTransaction } from '@lionpocket/core';
import type { MoneyKind, TransactionInput } from '@lionpocket/core';

export function parseMoney(text: string, allowZero = false): number {
  if (!/^\d+([,.]\d{1,2})?$/.test(text.trim()))
    throw new Error('Informe um valor válido, como 12,50.');
  const cents = toCents(Number(text.trim().replace(',', '.')));
  if (cents === null || (allowZero ? cents < 0 : cents <= 0) || !Number.isSafeInteger(cents))
    throw new Error('Informe um valor válido maior que zero.');
  return fromCents(cents) ?? 0;
}

export function parseTransactionForm(
  kind: MoneyKind,
  description: string,
  amountText: string,
  dueDate: string,
  settled: boolean,
): TransactionInput {
  const amount = parseMoney(amountText);
  const input: TransactionInput = {
    kind,
    description: description.trim(),
    plannedAmount: amount,
    actualAmount: settled ? amount : null,
    dueDate,
    settledDate: settled ? settlementDateFor(dueDate) : null,
    status: settled ? (kind === 'income' ? 'received' : 'paid') : 'planned',
  };
  validateTransaction(input);
  return input;
}
