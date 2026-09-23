import type { Transaction } from './types';

export interface CreditCardInvoice {
  key: string;
  cardId: string | null;
  paymentMethodId: string | null;
  name: string;
  dueDate: string;
  overdue: boolean;
  items: Transaction[];
  total: number;
}

const normalizePaymentMethodName = (value: string | null) => (value ?? '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLocaleLowerCase('pt-BR');

export const isCreditCardPaymentMethodName = (name: string | null) =>
  normalizePaymentMethodName(name) === 'cartao de credito';

export const isCreditCardTransaction = (
  transaction: Pick<Transaction, 'cardId' | 'paymentMethodName'>,
) => Boolean(transaction.cardId)
  || isCreditCardPaymentMethodName(transaction.paymentMethodName);

const invoiceIdentity = (transaction: Transaction) => {
  if (transaction.cardId) return `card:${transaction.cardId}`;
  if (transaction.paymentMethodId) return `payment:${transaction.paymentMethodId}`;
  return 'unassigned';
};

export const groupCreditCardInvoices = (transactions: Transaction[]): CreditCardInvoice[] => {
  const invoices = new Map<string, CreditCardInvoice>();
  for (const transaction of transactions) {
    if (transaction.kind !== 'expense' || !isCreditCardTransaction(transaction)) continue;

    const identity = invoiceIdentity(transaction);
    const key = `invoice:${identity}:${transaction.dueDate}`;
    const current = invoices.get(key) ?? {
      key,
      cardId: transaction.cardId,
      paymentMethodId: transaction.paymentMethodId,
      name: `Fatura ${transaction.cardName ?? 'sem cartão informado'}`,
      dueDate: transaction.dueDate,
      overdue: false,
      items: [],
      total: 0,
    };
    current.items.push(transaction);
    current.total += transaction.plannedAmount;
    current.overdue ||= transaction.isOverdue;
    invoices.set(key, current);
  }

  return [...invoices.values()].sort((left, right) => Number(right.overdue) - Number(left.overdue)
    || left.dueDate.localeCompare(right.dueDate)
    || left.name.localeCompare(right.name, 'pt-BR'));
};
