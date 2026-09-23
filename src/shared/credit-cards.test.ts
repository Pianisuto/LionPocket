import { describe, expect, it } from 'vitest';
import type { Transaction } from './types';
import {
  groupCreditCardInvoices,
  isCreditCardPaymentMethodName,
  isCreditCardTransaction,
} from './credit-cards';

const transaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'purchase',
  kind: 'expense',
  description: 'Compra',
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  plannedAmount: 100,
  actualAmount: null,
  purchaseDate: null,
  dueDate: '2026-07-21',
  settledDate: null,
  status: 'planned',
  paymentMethodId: 'credit',
  paymentMethodName: 'Cartão de crédito',
  cardId: 'nubank',
  cardName: 'NuBank',
  notes: '',
  sourceType: 'manual',
  sourceId: null,
  installmentNumber: null,
  installmentTotal: null,
  isOverdue: false,
  priorityPosition: null,
  ...overrides,
});

describe('isCreditCardTransaction', () => {
  it.each(['Cartão de crédito', 'cartão de crédito', 'CARTÃO DE CRÉDITO', 'Cartao de credito'])(
    'reconhece a forma de pagamento %s sem depender de acentos ou caixa',
    (paymentMethodName) => {
      expect(isCreditCardTransaction(transaction({ cardId: null, paymentMethodName }))).toBe(true);
    },
  );

  it('considera cartão um lançamento com cardId mesmo se a forma de pagamento for outra', () => {
    expect(isCreditCardTransaction(transaction({ cardId: 'nubank', paymentMethodName: 'Boleto' }))).toBe(true);
  });

  it('não classifica um lançamento comum sem cartão', () => {
    expect(isCreditCardTransaction(transaction({
      cardId: null,
      paymentMethodName: 'Pix',
    }))).toBe(false);
  });
});

describe('isCreditCardPaymentMethodName', () => {
  it.each(['Cartão de crédito', 'cartão de crédito', 'CARTÃO DE CRÉDITO', 'Cartao de credito'])(
    'reconhece %s de acordo com a normalização da busca',
    (name) => {
      expect(isCreditCardPaymentMethodName(name)).toBe(true);
    },
  );

  it('não confunde outras formas de pagamento com cartão de crédito', () => {
    expect(isCreditCardPaymentMethodName('Pix')).toBe(false);
    expect(isCreditCardPaymentMethodName(null)).toBe(false);
  });
});

describe('groupCreditCardInvoices', () => {
  it('soma e mantém na fatura somente compras do mesmo cartão e vencimento', () => {
    const invoice = groupCreditCardInvoices([
      transaction({ id: 'included-a', plannedAmount: 15.25, actualAmount: 500 }),
      transaction({ id: 'included-b', plannedAmount: 24.5 }),
      transaction({ id: 'different-due-date', dueDate: '2026-08-21', plannedAmount: 80 }),
      transaction({ id: 'different-card', cardId: 'visa', cardName: 'Visa', plannedAmount: 90 }),
      transaction({ id: 'ordinary', cardId: null, paymentMethodName: 'Pix' }),
    ]).find((group) => group.dueDate === '2026-07-21');

    expect(invoice).toMatchObject({
      cardId: 'nubank',
      name: 'Fatura NuBank',
      dueDate: '2026-07-21',
      total: 39.75,
    });
    expect(invoice?.items.map((item) => item.id)).toEqual(['included-a', 'included-b']);
  });

  it('mantém faturas separadas para vencimentos ou cartões diferentes', () => {
    const invoices = groupCreditCardInvoices([
      transaction({ id: 'nubank-july' }),
      transaction({ id: 'nubank-august', dueDate: '2026-08-21' }),
      transaction({ id: 'visa-july', cardId: 'visa', cardName: 'Visa' }),
    ]);

    expect(invoices.map((group) => [group.cardId, group.dueDate, group.items.map((item) => item.id)])).toEqual([
      ['nubank', '2026-07-21', ['nubank-july']],
      ['visa', '2026-07-21', ['visa-july']],
      ['nubank', '2026-08-21', ['nubank-august']],
    ]);
  });

  it('agrupa compras identificadas como crédito mesmo sem cardId', () => {
    const invoices = groupCreditCardInvoices([
      transaction({ id: 'unassigned-a', cardId: null, cardName: null, paymentMethodId: null }),
      transaction({ id: 'unassigned-b', cardId: null, cardName: null, paymentMethodId: null, plannedAmount: 25 }),
    ]);

    expect(invoices).toMatchObject([{
      cardId: null,
      paymentMethodId: null,
      name: 'Fatura sem cartão informado',
      total: 125,
      items: [{ id: 'unassigned-a' }, { id: 'unassigned-b' }],
    }]);
  });

  it('prioriza faturas atrasadas', () => {
    const invoices = groupCreditCardInvoices([
      transaction({ id: 'current', dueDate: '2026-09-10', isOverdue: false }),
      transaction({ id: 'overdue', dueDate: '2026-07-10', isOverdue: true }),
    ]);

    expect(invoices.map((group) => group.items.map((item) => item.id))).toEqual([['overdue'], ['current']]);
  });

  it('não cria faturas para contas comuns ou entradas', () => {
    expect(groupCreditCardInvoices([
      transaction({ id: 'ordinary', cardId: null, paymentMethodName: 'Pix' }),
      transaction({ id: 'income', kind: 'income', cardId: 'nubank' }),
    ])).toEqual([]);
  });
});
