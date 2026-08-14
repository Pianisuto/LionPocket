import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LionPocketDatabase } from './database';

const temporaryDirectories: string[] = [];

const createDatabase = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lionpocket-test-'));
  temporaryDirectories.push(directory);
  return new LionPocketDatabase(path.join(directory, 'test.sqlite'));
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('despesas fixas', () => {
  it('atualiza meses planejados e preserva os que já foram pagos', () => {
    const database = createDatabase();
    const recurring = database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Internet antiga',
      startMonth: '2026-01',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 120,
      dueDay: 31,
      notes: 'Plano antigo',
    });

    const january = database.listTransactions({ month: '2026-01' })[0];
    const february = database.listTransactions({ month: '2026-02' })[0];
    database.settleTransaction(january.id);

    database.saveRecurringExpense({
      ...recurring,
      description: 'Internet nova',
      plannedAmount: 150,
      dueDay: 15,
      notes: 'Plano novo',
    });

    const paidJanuary = database.listTransactions({ month: '2026-01' })[0];
    const plannedFebruary = database.listTransactions({ month: '2026-02' })[0];
    const newMarch = database.listTransactions({ month: '2026-03' })[0];

    expect(paidJanuary).toMatchObject({
      description: 'Internet antiga',
      plannedAmount: 120,
      actualAmount: 120,
      dueDate: '2026-01-31',
      status: 'paid',
      notes: 'Plano antigo',
    });
    expect(plannedFebruary).toMatchObject({
      id: february.id,
      description: 'Internet nova',
      plannedAmount: 150,
      actualAmount: null,
      dueDate: '2026-02-15',
      status: 'planned',
      notes: 'Plano novo',
    });
    expect(newMarch).toMatchObject({
      description: 'Internet nova',
      plannedAmount: 150,
      dueDate: '2026-03-15',
      status: 'planned',
    });

    database.db.close();
  });
});

describe('entradas fixas', () => {
  it('gera uma entrada planejada todo mês e permite marcá-la como recebida', () => {
    const database = createDatabase();
    const salaryCategory = database.findOrCreateCategory('Salário CLT', 'income');
    database.saveRecurringExpense({
      kind: 'income',
      active: true,
      description: 'Salário',
      startMonth: '2026-08',
      categoryId: salaryCategory,
      paymentMethodId: null,
      plannedAmount: 4500,
      dueDay: 5,
      notes: 'Entrada mensal',
    });

    expect(database.listTransactions({ month: '2026-07' })).toEqual([]);
    const august = database.listTransactions({ month: '2026-08' })[0];
    expect(august).toMatchObject({
      kind: 'income',
      description: 'Salário',
      categoryName: 'Salário CLT',
      plannedAmount: 4500,
      dueDate: '2026-08-05',
      status: 'planned',
    });

    database.settleTransaction(august.id);
    expect(database.listTransactions({ month: '2026-08' })[0]).toMatchObject({
      status: 'received',
      actualAmount: 4500,
    });
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      kind: 'income',
      dueDate: '2026-09-05',
      status: 'planned',
    });

    database.db.close();
  });

  it('impede nomes duplicados no mesmo tipo sem diferenciar maiúsculas', () => {
    const database = createDatabase();
    database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Internet',
      startMonth: '2026-08',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 120,
      dueDay: 10,
      notes: '',
    });

    expect(() => database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: '  INTERNET  ',
      startMonth: '2026-09',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 130,
      dueDay: 15,
      notes: '',
    })).toThrow('Já existe uma saída fixa com esse nome');

    expect(() => database.saveRecurringExpense({
      kind: 'income',
      active: true,
      description: 'Internet',
      startMonth: '2026-08',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 120,
      dueDay: 10,
      notes: '',
    })).not.toThrow();
    database.db.close();
  });

  it('oculta lançamentos antigos gerados antes do início da recorrência sem apagá-los', () => {
    const database = createDatabase();
    const recurring = database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Academia',
      startMonth: '2026-08',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 100,
      dueDay: 10,
      notes: '',
    });
    database.db.prepare(`
      INSERT INTO transactions(
        id, kind, description, planned_cents, due_date, status, notes,
        source_type, source_id, created_at, updated_at
      ) VALUES (?, 'expense', 'Academia', 10000, '2026-07-10', 'planned', '',
        'recurring', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run('legacy-before-recurring-start', recurring.id);

    expect(database.listTransactions({ month: '2026-07' })).toEqual([]);
    expect(database.getOverview('2026-07').summary.plannedExpenses).toBe(0);
    expect(database.db.prepare(`
      SELECT COUNT(*) AS count FROM transactions WHERE id = 'legacy-before-recurring-start'
    `).get()).toMatchObject({ count: 1 });
    database.db.close();
  });
});

describe('cartões e compras parceladas', () => {
  it('não cria um cartão Principal automaticamente', () => {
    const database = createDatabase();

    expect(database.getCatalogs().cards).toEqual([]);

    database.db.close();
  });

  it('salva e permite alterar o dia de vencimento de um cartão', () => {
    const database = createDatabase();
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 7 });
    const card = database.getCatalogs().cards.find((item) => item.name === 'Nubank');

    expect(card).toMatchObject({ name: 'Nubank', dueDay: 7 });

    database.createCatalogItem({ id: card?.id, type: 'card', name: 'Nubank Roxinho', dueDay: 12 });
    expect(database.getCatalogs().cards.find((item) => item.id === card?.id)).toMatchObject({
      name: 'Nubank Roxinho',
      dueDay: 12,
    });

    database.db.close();
  });

  it('começa na parcela atual sem recriar as parcelas que já foram pagas', () => {
    const database = createDatabase();
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 10 });
    const card = database.getCatalogs().cards[0];
    const purchase = database.createInstallmentPurchase({
      description: 'Notebook',
      categoryId: null,
      paymentMethodId: null,
      cardId: card.id,
      installmentAmount: 250,
      totalInstallments: 6,
      currentInstallment: 4,
      currentDueDate: '2026-08-10',
      notes: '',
    });

    expect(purchase).toMatchObject({
      totalInstallments: 6,
      startingInstallment: 4,
      paidInstallments: 3,
      firstDueDate: '2026-05-10',
    });
    expect(database.listTransactions({ month: '2026-05' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-08' })[0]).toMatchObject({
      description: 'Notebook',
      installmentNumber: 4,
      installmentTotal: 6,
      dueDate: '2026-08-10',
    });
    expect(database.listTransactions({ month: '2026-10' })[0]).toMatchObject({
      installmentNumber: 6,
      dueDate: '2026-10-10',
    });

    database.settleTransaction(database.listTransactions({ month: '2026-08' })[0].id);
    expect(database.listInstallmentPurchases('2026-07')).toEqual([]);
    expect(database.listInstallmentPurchases('2026-08')[0]).toMatchObject({
      viewedInstallment: 4,
      viewedDueDate: '2026-08-10',
      viewedStatus: 'paid',
      paidInstallments: 4,
    });
    expect(database.listInstallmentPurchases('2026-09')[0]).toMatchObject({
      viewedInstallment: 5,
      viewedDueDate: '2026-09-10',
      viewedStatus: 'planned',
      paidInstallments: 4,
    });
    expect(database.listInstallmentPurchases('2026-11')).toEqual([]);

    database.db.close();
  });

  it('exclui cartão e categoria sem apagar lançamentos nem recriar os itens', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lionpocket-delete-catalog-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'test.sqlite');
    const database = new LionPocketDatabase(databasePath);
    const category = database.getCatalogs().categories.find((item) => item.name === 'Casa' && item.kind === 'expense');
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 21 });
    const card = database.getCatalogs().cards.find((item) => item.name === 'Nubank');
    if (!category || !card) throw new Error('Catálogos do teste não foram criados');

    const transaction = database.saveTransaction({
      kind: 'expense',
      description: 'Compra de teste',
      categoryId: category?.id,
      plannedAmount: 100,
      dueDate: '2026-08-21',
      status: 'planned',
      cardId: card?.id,
    });

    database.deleteCatalogItem('category', category.id);
    database.deleteCatalogItem('card', card.id);
    expect(database.listTransactions({ month: '2026-08' }).find((item) => item.id === transaction.id)).toMatchObject({
      categoryId: null,
      cardId: null,
    });
    database.db.close();

    const reopened = new LionPocketDatabase(databasePath);
    expect(reopened.getCatalogs().categories.some((item) => item.id === category.id)).toBe(false);
    expect(reopened.getCatalogs().cards).toEqual([]);
    reopened.db.close();
  });
});

describe('busca de lançamentos', () => {
  it('ignora acentos e também encontra forma de pagamento', () => {
    const database = createDatabase();
    const credit = database.getCatalogs().paymentMethods.find((method) => method.name === 'Cartão de crédito');
    database.saveTransaction({
      kind: 'expense',
      description: 'Água',
      categoryId: null,
      plannedAmount: 150,
      actualAmount: null,
      dueDate: '2026-08-10',
      settledDate: null,
      status: 'planned',
      paymentMethodId: credit?.id ?? null,
      cardId: null,
      notes: '',
    });

    expect(database.listTransactions({ month: '2026-08', search: 'agua' })[0]?.description).toBe('Água');
    expect(database.listTransactions({ month: '2026-08', search: 'cartao de credito' })[0]?.description).toBe('Água');
    database.db.close();
  });
});

const plan = (
  database: LionPocketDatabase,
  kind: 'income' | 'expense',
  description: string,
  dueDate: string,
  plannedAmount: number,
) =>
  database.saveTransaction({
    kind,
    description,
    categoryId: null,
    plannedAmount,
    actualAmount: null,
    dueDate,
    settledDate: null,
    status: 'planned',
    paymentMethodId: null,
    cardId: null,
    notes: '',
  });

describe('meses já encerrados', () => {
  it('quita a lista inteira usando o planejado e a data do vencimento', () => {
    const database = createDatabase();
    const internet = plan(database, 'expense', 'Internet', '2020-03-10', 120);
    const salary = plan(database, 'income', 'Salário CLT', '2020-03-05', 4000);
    const future = plan(database, 'expense', 'Luz', '2999-03-20', 300);
    database.settleTransaction(future.id);

    const settled = database.settleTransactions([internet.id, salary.id, future.id]);

    // A conta futura já estava quitada e não entra na contagem.
    expect(settled).toBe(2);
    expect(database.listTransactions({ month: '2020-03' })).toMatchObject([
      { description: 'Salário CLT', status: 'received', actualAmount: 4000, settledDate: '2020-03-05' },
      { description: 'Internet', status: 'paid', actualAmount: 120, settledDate: '2020-03-10' },
    ]);

    database.db.close();
  });

  it('não mexe em quem já foi cancelado ou pago à mão', () => {
    const database = createDatabase();
    const bill = plan(database, 'expense', 'Aluguel', '2020-03-10', 1500);
    database.saveTransaction({
      id: bill.id,
      kind: 'expense',
      description: 'Aluguel',
      categoryId: null,
      plannedAmount: 1500,
      actualAmount: 1480,
      dueDate: '2020-03-10',
      settledDate: '2020-03-08',
      status: 'paid',
      paymentMethodId: null,
      cardId: null,
      notes: '',
    });

    expect(database.settleTransactions([bill.id])).toBe(0);
    expect(database.listTransactions({ month: '2020-03' })[0]).toMatchObject({
      actualAmount: 1480,
      settledDate: '2020-03-08',
    });

    database.db.close();
  });
});

describe('sugestões de lançamento', () => {
  it('devolve o lançamento parecido mais usado, com categoria e valor', () => {
    const database = createDatabase();
    const mercado = database.findOrCreateCategory('Alimentação', 'expense');
    for (const month of ['01', '02', '03']) {
      database.saveTransaction({
        kind: 'expense',
        description: 'Supermercado',
        categoryId: mercado,
        plannedAmount: 500,
        actualAmount: month === '03' ? 540 : 500,
        dueDate: `2020-${month}-08`,
        settledDate: `2020-${month}-08`,
        status: 'paid',
        paymentMethodId: null,
        cardId: null,
        notes: '',
      });
    }
    plan(database, 'expense', 'Super trunfo', '2020-04-08', 40);
    plan(database, 'income', 'Supermercado devolução', '2020-04-09', 30);

    const suggestions = database.suggestTransactions('expense', 'super');

    expect(suggestions).toMatchObject([
      { description: 'Supermercado', categoryName: 'Alimentação', amount: 540, uses: 3 },
      { description: 'Super trunfo', amount: 40, uses: 1 },
    ]);
    // Uma entrada nunca vira sugestão de saída.
    expect(suggestions.map((item) => item.description)).not.toContain('Supermercado devolução');
    expect(database.suggestTransactions('expense', 's')).toEqual([]);

    database.db.close();
  });

  it('trata % e _ como texto comum, não como curinga', () => {
    const database = createDatabase();
    plan(database, 'expense', 'Internet', '2020-05-10', 120);

    expect(database.suggestTransactions('expense', '%e%')).toEqual([]);

    database.db.close();
  });
});

describe('contas a caminho', () => {
  it('mostra só despesas do mês aberto, sem entradas e sem outros meses', () => {
    const database = createDatabase();

    plan(database, 'expense', 'Internet', '2026-05-10', 120);
    plan(database, 'expense', 'Luz', '2026-05-20', 600);
    plan(database, 'income', 'Salário CLT', '2026-05-05', 1489);
    plan(database, 'expense', 'Internet de junho', '2026-06-10', 120);
    plan(database, 'expense', 'Internet de abril', '2026-04-10', 120);

    const { upcoming } = database.getOverview('2026-05');

    expect(upcoming.map((item) => item.description)).toEqual(['Internet', 'Luz']);

    database.db.close();
  });

  it('deixa de listar a conta depois que ela é paga', () => {
    const database = createDatabase();
    const bill = plan(database, 'expense', 'Internet', '2026-05-10', 120);

    expect(database.getOverview('2026-05').upcoming).toHaveLength(1);

    database.settleTransaction(bill.id);

    expect(database.getOverview('2026-05').upcoming).toEqual([]);

    database.db.close();
  });
});
