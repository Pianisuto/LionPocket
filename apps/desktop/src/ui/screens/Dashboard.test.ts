import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Overview, Transaction } from '@lionpocket/core/types';
import { monthlyProtectionOverview } from '@lionpocket/core/free-now';
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
  const protect = (projected: number, marginCents: number) => monthlyProtectionOverview([], [], [], { month: '2026-10', safetyMarginCents: marginCents }, '2026-10', '2026-10-10', projected).protection;
  it('preserves the original hint with no configured margin, including zero', () => {
    expect(render(overview)).toContain('Se tudo ocorrer como planejado');
    expect(render(overview)).not.toContain('após margem de segurança');
    expect(render({ ...overview, protection: protect(3200, 0) })).toBe(render(overview));
  });
  it('keeps four cards and original projection while displaying availability as a hint', () => {
    const html = render({ ...overview, protection: protect(3200, 50000) });
    expect(html).toMatch(/3\.200,00/);
    expect(html).toMatch(/2\.700,00 após margem de segurança/);
    expect(html.match(/<article class="metric-card /g)).toHaveLength(4);
    expect(html).not.toContain('Se tudo ocorrer como planejado');
  });
  it('shows a negative amount after the margin without replacing the main projected balance', () => {
    const html = render({ ...overview, summary: { ...overview.summary, projectedBalance: 300 }, protection: protect(300, 50000) });
    expect(html).toMatch(/-R\$.*200,00 após margem de segurança/);
    expect(html).toMatch(/300,00/);
  });
});

describe('Livre agora in the Dashboard', () => {
  const day = (date: string, kind: Transaction['kind'], amount: number, extra: Partial<Transaction> = {}) => transaction({
    id: `${kind}-${date}-${amount}`, kind, dueDate: date, plannedAmount: amount, isOverdue: false, cardId: null, cardName: null, paymentMethodId: null, paymentMethodName: null, ...extra,
  });
  const items = [
    day('2026-10-05', 'income', 3000, { status: 'received', actualAmount: 3000, settledDate: '2026-10-05' }),
    day('2026-10-02', 'expense', 1000, { status: 'paid', actualAmount: 1000, settledDate: '2026-10-02' }),
    day('2026-10-12', 'expense', 200, { description: 'Luz' }),
    day('2026-10-14', 'expense', 100, { description: 'Internet' }),
    day('2026-10-15', 'income', 500, { description: 'Freela' }),
    day('2026-10-20', 'expense', 400, { description: 'Cartão' }),
  ];
  const overviewFor = (margin: number, reinforcement: number, today = '2026-10-10'): Overview => {
    const goals = [{ id: 'g', status: 'saving' as const }];
    const result = monthlyProtectionOverview(items, goals, reinforcement ? [{ goalId: 'g', month: '2026-10', amountCents: reinforcement }] : [], margin ? { month: '2026-10', safetyMarginCents: margin } : null, '2026-10', today, 1800);
    return { summary: { month: '2026-10', plannedIncome: 3500, receivedIncome: 3000, plannedExpenses: 1700, paidExpenses: 1000, overdueExpenses: 0, projectedBalance: 1800, realizedBalance: 2000, committedPercent: 0.48 }, annual: [], categoryBreakdown: [], upcoming: [], recent: [], goals: [], ...result };
  };
  const text = (data: Overview) => renderToStaticMarkup(createElement(Dashboard, { overview: data, loading: false, onNavigate: () => undefined, onEditTransaction: () => undefined, onSettleTransactions: async () => true })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const html = (data: Overview) => renderToStaticMarkup(createElement(Dashboard, { overview: data, loading: false, onNavigate: () => undefined, onEditTransaction: () => undefined, onSettleTransactions: async () => true }));

  it('keeps the four metric cards and adds a single compact strip, with Saldo projetado as the main card', () => {
    const markup = html(overviewFor(50000, 70000));
    expect(markup.match(/<article class="metric-card /g)).toHaveLength(4);
    expect(markup.match(/class="free-now"/g)).toHaveLength(1);
    expect(text(overviewFor(50000, 70000))).toMatch(/Saldo projetado R\$.*1\.800,00 R\$.*600,00 após proteções/);
  });
  it('shows the value, the period and the whole composition', () => {
    const content = text(overviewFor(50000, 70000));
    expect(content).toMatch(/Livre agora R\$.*500,00/);
    expect(content).toContain('O saldo do mês fica mais apertado em 14/10.');
    expect(content).toMatch(/Em mãos \(recebido − pago no mês\) R\$.*2\.000,00/);
    expect(content).toMatch(/Contas até 14\/10 -R\$.*300,00/);
    expect(content).toMatch(/Margem de segurança -R\$.*500,00/);
    expect(content).toMatch(/Objetivos -R\$.*700,00/);
  });
  it('works without protections: only the bills line, original projected hint', () => {
    const content = text(overviewFor(0, 0));
    expect(content).toMatch(/Livre agora R\$.*1\.700,00/);
    expect(content).toContain('Se tudo ocorrer como planejado');
    expect(content).not.toContain('Margem de segurança');
    expect(content).not.toContain('Objetivos -R$');
  });
  it('shows a negative value with the attention colour instead of zero', () => {
    const markup = html(overviewFor(150000, 70000));
    expect(markup).toMatch(/free-now__value money-negative">-R\$.*500,00/);
  });
  it('does not render the strip for other months or old overviews', () => {
    expect(html({ ...overviewFor(0, 0), freeNow: null })).not.toContain('free-now');
    const { freeNow: _unused, ...legacy } = overviewFor(0, 0);
    expect(html(legacy)).not.toContain('free-now');
  });
  it('says so when the tightest day is today', () => {
    const calm = monthlyProtectionOverview([items[0], items[4]], [], [], null, '2026-10', '2026-10-10', 0);
    expect(text({ ...overviewFor(0, 0), ...calm })).toContain('O saldo do mês fica mais apertado hoje; depois disso ele só se recupera.');
  });
});
