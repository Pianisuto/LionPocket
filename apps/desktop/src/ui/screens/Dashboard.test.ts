import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Overview, Transaction } from '@lionpocket/core/types';
import { Dashboard, groupUpcoming } from './Dashboard';

const transaction = (overrides: Partial<Transaction>): Transaction => ({
  id: 'transaction',
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
  isOverdue: true,
  priorityPosition: null,
  ...overrides,
});

describe('agrupamento de contas a pagar', () => {
  it('agrupa compras atrasadas por cartão e vencimento, sem misturar faturas', () => {
    const groups = groupUpcoming([
      transaction({ id: 'a', plannedAmount: 100 }),
      transaction({ id: 'b', plannedAmount: 50 }),
      transaction({ id: 'c', dueDate: '2026-08-21', plannedAmount: 80 }),
      transaction({ id: 'd', cardId: 'other', cardName: 'Outro', plannedAmount: 30 }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      name: 'Fatura NuBank',
      dueDate: '2026-07-21',
      total: 150,
      overdue: true,
    });
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups.map((group) => group.total)).toEqual([150, 30, 80]);
  });

  it('agrupa compras atuais do cartão e mantém lançamentos comuns separados', () => {
    const groups = groupUpcoming([
      transaction({ id: 'boleto', description: 'Moto', cardId: null, paymentMethodId: null, paymentMethodName: 'Boleto' }),
      transaction({ id: 'current-a', description: 'Mercado', isOverdue: false }),
      transaction({ id: 'current-b', description: 'Farmácia', plannedAmount: 50, isOverdue: false }),
    ]);

    expect(groups).toMatchObject([
      { name: 'Moto', total: 100, cardInvoice: false },
      {
        name: 'Fatura NuBank',
        total: 150,
        overdue: false,
        cardInvoice: true,
        detail: '2 compras na fatura',
      },
    ]);
    expect(groups[1].items.map((item) => item.id)).toEqual(['current-a', 'current-b']);
  });

  it('consolida compras no crédito sem cartão identificado', () => {
    const groups = groupUpcoming([
      transaction({ id: 'unassigned-a', cardId: null, cardName: null, isOverdue: false }),
      transaction({ id: 'unassigned-b', cardId: null, cardName: null, plannedAmount: 25, isOverdue: false }),
    ]);

    expect(groups).toMatchObject([{
      name: 'Fatura sem cartão informado',
      total: 125,
      cardInvoice: true,
      detail: '2 compras na fatura',
    }]);
  });

  it.each(['Cartão de crédito', 'cartão de crédito', 'CARTÃO DE CRÉDITO', 'Cartao de credito'])(
    'identifica %s como forma de pagamento de cartão sem depender de acentos ou caixa',
    (paymentMethodName) => {
      const [invoice] = groupUpcoming([transaction({
        id: 'legacy-card-purchase',
        cardId: null,
        cardName: null,
        paymentMethodId: null,
        paymentMethodName,
        isOverdue: false,
      })]);

      expect(invoice).toMatchObject({
        name: 'Fatura sem cartão informado',
        cardInvoice: true,
        items: [{ id: 'legacy-card-purchase' }],
      });
    },
  );

  it('agrupa somente pela combinação de cartão e vencimento', () => {
    const groups = groupUpcoming([
      transaction({ id: 'nu-july-a', plannedAmount: 10.25 }),
      transaction({ id: 'nu-july-b', plannedAmount: 20.5 }),
      transaction({ id: 'nu-august', dueDate: '2026-08-21', plannedAmount: 30.75 }),
      transaction({ id: 'other-july', cardId: 'other', cardName: 'Outro', plannedAmount: 40.25 }),
    ]);

    expect(groups).toMatchObject([
      { name: 'Fatura NuBank', dueDate: '2026-07-21', total: 30.75, items: [{ id: 'nu-july-a' }, { id: 'nu-july-b' }] },
      { name: 'Fatura Outro', dueDate: '2026-07-21', total: 40.25, items: [{ id: 'other-july' }] },
      { name: 'Fatura NuBank', dueDate: '2026-08-21', total: 30.75, items: [{ id: 'nu-august' }] },
    ]);
  });

  it('prioriza faturas atrasadas e limita a lista aos cinco primeiros grupos', () => {
    const groups = groupUpcoming([
      transaction({ id: 'current-a', dueDate: '2026-09-01', isOverdue: false }),
      transaction({ id: 'late', dueDate: '2026-07-01', isOverdue: true }),
      transaction({ id: 'current-b', cardId: 'b', cardName: 'B', dueDate: '2026-09-02', isOverdue: false }),
      transaction({ id: 'current-c', cardId: 'c', cardName: 'C', dueDate: '2026-09-03', isOverdue: false }),
      transaction({ id: 'current-d', cardId: 'd', cardName: 'D', dueDate: '2026-09-04', isOverdue: false }),
      transaction({ id: 'current-e', cardId: 'e', cardName: 'E', dueDate: '2026-09-05', isOverdue: false }),
    ]);

    expect(groups).toHaveLength(5);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ['late'],
      ['current-a'],
      ['current-b'],
      ['current-c'],
      ['current-d'],
    ]);
  });
});

describe('exibição de contas a pagar', () => {
  it('mostra o vencimento da fatura no mesmo formato das outras contas', () => {
    const overview: Overview = {
      summary: {
        month: '2026-07',
        plannedIncome: 0,
        receivedIncome: 0,
        plannedExpenses: 100,
        paidExpenses: 0,
        overdueExpenses: 0,
        projectedBalance: -100,
        realizedBalance: 0,
        committedPercent: 0,
      },
      annual: [],
      categoryBreakdown: [],
      upcoming: [transaction({ id: 'current', isOverdue: false })],
      recent: [],
      goals: [],
    };

    const markup = renderToStaticMarkup(createElement(Dashboard, {
      overview,
      loading: false,
      onNavigate: () => undefined,
      onEditTransaction: () => undefined,
      onSettleTransactions: async () => true,
    }));

    expect(markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('21 jul');
  });
});

describe('auxiliary safety margin in the existing projected balance card', () => {
  const overview: Overview = {
    summary: { month: '2026-10', plannedIncome: 3200, receivedIncome: 0, plannedExpenses: 0, paidExpenses: 0, overdueExpenses: 0, projectedBalance: 3200, realizedBalance: 0, committedPercent: 0 },
    annual: [], categoryBreakdown: [], upcoming: [], recent: [], goals: [],
  };
  const render = (data: Overview) => renderToStaticMarkup(createElement(Dashboard, { overview: data, loading: false, onNavigate: () => undefined, onEditTransaction: () => undefined, onSettleTransactions: async () => true }));
  it('preserves the original hint with no configured margin, including zero', () => {
    expect(render(overview)).toContain('Se tudo ocorrer como planejado');
    expect(render(overview)).not.toContain('após margem de segurança');
    expect(render({ ...overview, planning: { projectedBalance: 3200, safetyMargin: 0, balanceAfterSafetyMargin: 3200 } })).toBe(render(overview));
  });
  it('keeps four cards and original projection while displaying availability as a hint', () => {
    const html = render({ ...overview, planning: { projectedBalance: 3200, safetyMargin: 500, balanceAfterSafetyMargin: 2700 } });
    expect(html).toMatch(/3\.200,00/);
    expect(html).toMatch(/2\.700,00 após margem de segurança/);
    expect(html.match(/<article class="metric-card /g)).toHaveLength(4);
    expect(html).not.toContain('Se tudo ocorrer como planejado');
  });
  it('shows a negative amount after the margin without replacing the main projected balance', () => {
    const html = render({ ...overview, summary: { ...overview.summary, projectedBalance: 300 }, planning: { projectedBalance: 300, safetyMargin: 500, balanceAfterSafetyMargin: -200 } });
    expect(html).toMatch(/-R\$.*200,00 após margem de segurança/);
    expect(html).toMatch(/300,00/);
  });
});
