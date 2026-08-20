import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LionPocketDatabase } from './database';
import { addMonths, currentMonthIso, todayIso } from '../shared/finance';

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
  it('não recria uma ocorrência excluída ao consultar o mesmo mês', () => {
    const database = createDatabase();
    database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Academia',
      startMonth: '2026-10',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 100,
      dueDay: 10,
      notes: '',
    });

    const october = database.listTransactions({ month: '2026-10' });
    expect(october).toHaveLength(1);

    database.deleteTransaction(october[0].id);

    expect(database.listTransactions({ month: '2026-10' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-11' })[0]).toMatchObject({
      description: 'Academia',
      dueDate: '2026-11-10',
      sourceType: 'recurring',
    });
    database.db.close();
  });

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
    const february = database.listTransactions({ month: '2026-02' }).find((item) => item.dueDate === '2026-02-28');
    if (!february) throw new Error('A ocorrência de fevereiro não foi criada.');
    database.settleTransaction(january.id);

    database.saveRecurringExpense({
      ...recurring,
      description: 'Internet nova',
      plannedAmount: 150,
      dueDay: 15,
      notes: 'Plano novo',
    });

    const paidJanuary = database.listTransactions({ month: '2026-01' })[0];
    const plannedFebruary = database.listTransactions({ month: '2026-02' }).find((item) => item.dueDate === '2026-02-15');
    const newMarch = database.listTransactions({ month: '2026-03' }).find((item) => item.dueDate === '2026-03-15');

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

  it('coloca uma cobrança recorrente no mês da fatura do cartão', () => {
    const database = createDatabase();
    database.createCatalogItem({
      type: 'card',
      name: 'Nubank',
      closingDay: 14,
      dueDay: 21,
    });
    const card = database.getCatalogs().cards[0];
    const credit = database.getCatalogs().paymentMethods.find((method) => method.name === 'Cartão de crédito');
    const recurring = database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'ChatGPT',
      startMonth: '2026-08',
      categoryId: null,
      paymentMethodId: credit?.id ?? null,
      cardId: card.id,
      plannedAmount: 110,
      dueDay: card.dueDay,
      chargeDay: 20,
      notes: '',
    });

    expect(recurring).toMatchObject({
      cardId: card.id,
      cardName: 'Nubank',
      chargeDay: 20,
      dueDay: 21,
    });
    expect(database.listTransactions({ month: '2026-08' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      description: 'ChatGPT',
      purchaseDate: '2026-08-20',
      dueDate: '2026-09-21',
      cardId: card.id,
    });
    expect(database.listTransactions({ month: '2026-10' }).find((item) => item.purchaseDate === '2026-09-20')).toMatchObject({
      purchaseDate: '2026-09-20',
      dueDate: '2026-10-21',
    });
    database.db.close();
  });

  it('move para a fatura correta apenas o lançamento recorrente ainda planejado', () => {
    const database = createDatabase();
    const recurring = database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Assinatura',
      startMonth: '2026-08',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 50,
      dueDay: 21,
      notes: '',
    });
    const augustPending = database.listTransactions({ month: '2026-08' })[0];
    database.createCatalogItem({
      type: 'card',
      name: 'Nubank',
      closingDay: 14,
      dueDay: 21,
    });
    const card = database.getCatalogs().cards[0];

    database.saveRecurringExpense({
      ...recurring,
      cardId: card.id,
      chargeDay: 20,
    });

    expect(database.listTransactions({ month: '2026-08' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      id: augustPending.id,
      purchaseDate: '2026-08-20',
      dueDate: '2026-09-21',
      cardId: card.id,
    });
    database.db.close();
  });

  it('completa o dia de cobrança legado sem duplicar uma fatura já preservada', () => {
    const database = createDatabase();
    const recurring = database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Assinatura antiga',
      startMonth: '2026-09',
      categoryId: null,
      paymentMethodId: null,
      plannedAmount: 50,
      dueDay: 10,
      notes: '',
    });
    const septemberPending = database.listTransactions({ month: '2026-09' })[0];
    const octoberPreserved = database.listTransactions({ month: '2026-10' })[0];
    database.settleTransaction(octoberPreserved.id);
    database.createCatalogItem({
      type: 'card',
      name: 'Nubank',
      closingDay: 25,
      dueDay: 10,
    });
    const card = database.getCatalogs().cards[0];

    expect(() => database.saveRecurringExpense({
      ...recurring,
      cardId: card.id,
      chargeDay: 21,
    })).not.toThrow();

    expect(database.listTransactions({ month: '2026-09' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-10' })).toEqual([
      expect.objectContaining({
        id: octoberPreserved.id,
        description: 'Assinatura antiga',
        purchaseDate: null,
        dueDate: '2026-10-10',
        status: 'paid',
      }),
    ]);
    expect(database.db.prepare(`
      SELECT deleted_at AS deletedAt FROM transactions WHERE id = ?
    `).get(septemberPending.id)).toMatchObject({ deletedAt: expect.any(String) });
    expect(database.listTransactions({ month: '2026-11' })[0]).toMatchObject({
      purchaseDate: '2026-10-21',
      dueDate: '2026-11-10',
      cardId: card.id,
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

describe('recorrências flexíveis', () => {
  it('gera ciclos semanais, uma ocorrência única e nenhum lançamento manual', () => {
    const database = createDatabase();
    database.saveRecurringExpense({
      kind: 'expense', active: true, description: 'Feira semanal',
      frequency: 'weekly', startMonth: '2099-01', startDate: '2099-01-03',
      plannedAmount: 80, dueDay: 3,
    });
    database.saveRecurringExpense({
      kind: 'expense', active: true, description: 'Taxa única',
      frequency: 'once', startMonth: '2099-01', startDate: '2099-01-12',
      plannedAmount: 40, dueDay: 12,
    });
    database.saveRecurringExpense({
      kind: 'expense', active: true, description: 'Compra quando necessário',
      frequency: 'manual', manualMonths: ['02', '04'],
      startMonth: '2099-01', plannedAmount: 100, dueDay: 1,
    });

    const january = database.listTransactions({ month: '2099-01' });
    expect(january.filter((item) => item.description === 'Feira semanal').map((item) => item.dueDate))
      .toEqual(['2099-01-03', '2099-01-10', '2099-01-17', '2099-01-24', '2099-01-31']);
    expect(january.filter((item) => item.description === 'Taxa única')).toHaveLength(1);
    expect(january.some((item) => item.description === 'Compra quando necessário')).toBe(false);
    expect(database.listTransactions({ month: '2099-02' }).some((item) => item.description === 'Taxa única')).toBe(false);
    expect(database.listTransactions({ month: '2099-02' }).find((item) => item.description === 'Compra quando necessário'))
      .toMatchObject({ dueDate: '2099-02-01' });
    expect(database.listTransactions({ month: '2099-03' }).some((item) => item.description === 'Compra quando necessário')).toBe(false);
    expect(database.listTransactions({ month: '2100-02' }).find((item) => item.description === 'Compra quando necessário'))
      .toMatchObject({ dueDate: '2100-02-01' });
    database.db.close();
  });

  it('recalcula intervalo personalizado pela data efetiva da última ocorrência', () => {
    const database = createDatabase();
    database.saveRecurringExpense({
      kind: 'expense', active: true, description: 'Ração',
      frequency: 'custom', intervalCount: 3, intervalUnit: 'months', anchorToActual: true,
      startMonth: '2099-01', startDate: '2099-01-10', plannedAmount: 180, dueDay: 10,
    });
    const january = database.listTransactions({ month: '2099-01' })[0];
    expect(database.listTransactions({ month: '2099-04' })[0]).toMatchObject({ dueDate: '2099-04-10' });

    database.saveTransaction({
      ...january,
      actualAmount: 180,
      settledDate: '2099-02-01',
      status: 'paid',
    });

    expect(database.listTransactions({ month: '2099-04' })).toEqual([]);
    expect(database.listTransactions({ month: '2099-05' })[0]).toMatchObject({
      description: 'Ração',
      dueDate: '2099-05-01',
      status: 'planned',
    });
    database.db.close();
  });
});

describe('cartões e compras parceladas', () => {
  it('não cria um cartão Principal automaticamente', () => {
    const database = createDatabase();

    expect(database.getCatalogs().cards).toEqual([]);

    database.db.close();
  });

  it('preserva cartão antigo sem fechamento e permite configurar o ciclo', () => {
    const database = createDatabase();
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 7 });
    const card = database.getCatalogs().cards.find((item) => item.name === 'Nubank');

    expect(card).toMatchObject({ name: 'Nubank', dueDay: 7, closingDay: null });

    database.createCatalogItem({
      id: card?.id,
      type: 'card',
      name: 'Nubank Roxinho',
      dueDay: 21,
      closingDay: 14,
    });
    expect(database.getCatalogs().cards.find((item) => item.id === card?.id)).toMatchObject({
      name: 'Nubank Roxinho',
      dueDay: 21,
      closingDay: 14,
    });

    database.db.close();
  });

  it('guarda a data da compra sem tirar o lançamento do mês da fatura', () => {
    const database = createDatabase();
    database.createCatalogItem({
      type: 'card',
      name: 'Nubank',
      dueDay: 21,
      closingDay: 14,
    });
    const card = database.getCatalogs().cards[0];

    database.saveTransaction({
      kind: 'expense',
      description: 'Compra depois do fechamento',
      plannedAmount: 80,
      purchaseDate: '2026-08-15',
      dueDate: '2026-09-21',
      status: 'planned',
      cardId: card.id,
    });

    expect(database.listTransactions({ month: '2026-08' })).toEqual([]);
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      purchaseDate: '2026-08-15',
      dueDate: '2026-09-21',
      cardId: card.id,
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
    expect(database.listTransactions({ month: '2026-10' }).find((item) => item.installmentNumber === 6)).toMatchObject({
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

  it('persiste todas as parcelas em banco novo e continua correto após reabrir', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'lionpocket-installments-fresh-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'fresh.sqlite');
    const database = new LionPocketDatabase(databasePath);
    const purchase = database.createInstallmentPurchase({
      description: 'Celular',
      installmentAmount: 300,
      totalInstallments: 3,
      currentInstallment: 1,
      purchaseDate: '2099-01-20',
      currentDueDate: '2099-02-10',
    });

    expect(purchase).toMatchObject({ viewedInstallment: 1, viewedDueDate: '2099-02-10' });
    expect(database.listTransactions({ month: '2099-02' })[0]).toMatchObject({ installmentNumber: 1 });
    expect(database.listTransactions({ month: '2099-03' })[0]).toMatchObject({ installmentNumber: 2 });
    expect(database.listTransactions({ month: '2099-04' })[0]).toMatchObject({ installmentNumber: 3 });
    database.db.close();

    const reopened = new LionPocketDatabase(databasePath);
    expect(reopened.listInstallmentPurchases('2099-02')[0]).toMatchObject({
      id: purchase.id,
      viewedInstallment: 1,
      totalInstallments: 3,
    });
    expect(reopened.listTransactions({ month: '2099-04' })[0]).toMatchObject({
      sourceId: purchase.id,
      installmentNumber: 3,
      dueDate: '2099-04-10',
    });
    reopened.db.close();
  });

  it('edita parcelas em aberto sem alterar valor e vencimento das já pagas', () => {
    const database = createDatabase();
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 10 });
    const card = database.getCatalogs().cards[0];
    const purchase = database.createInstallmentPurchase({
      description: 'Notebook',
      cardId: card.id,
      installmentAmount: 250,
      totalInstallments: 3,
      currentInstallment: 1,
      purchaseDate: '2026-07-20',
      currentDueDate: '2026-08-10',
    });
    const august = database.listTransactions({ month: '2026-08' })[0];
    database.settleTransaction(august.id);

    database.saveInstallmentPurchase({
      id: purchase.id,
      description: 'Notebook trabalho',
      cardId: card.id,
      installmentAmount: 300,
      totalInstallments: 4,
      currentInstallment: 2,
      purchaseDate: '2026-07-20',
      currentDueDate: '2026-09-10',
    });

    expect(database.listTransactions({ month: '2026-08' })[0]).toMatchObject({
      description: 'Notebook trabalho',
      plannedAmount: 250,
      actualAmount: 250,
      dueDate: '2026-08-10',
      status: 'paid',
      installmentTotal: 4,
    });
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      description: 'Notebook trabalho',
      plannedAmount: 300,
      dueDate: '2026-09-10',
      installmentNumber: 2,
      installmentTotal: 4,
      status: 'planned',
    });
    expect(database.listTransactions({ month: '2026-11' })[0]).toMatchObject({
      installmentNumber: 4,
      plannedAmount: 300,
      dueDate: '2026-11-10',
    });
    expect(database.listInstallmentPurchases('2026-09')[0]).toMatchObject({
      description: 'Notebook trabalho',
      installmentAmount: 300,
      totalInstallments: 4,
      purchaseDate: '2026-07-20',
    });
    database.db.close();
  });

  it('corrige a numeração da parcela atual sem perder pagamentos já registrados', () => {
    const database = createDatabase();
    const purchase = database.createInstallmentPurchase({
      description: 'Oboticário',
      installmentAmount: 55.16,
      totalInstallments: 10,
      currentInstallment: 5,
      purchaseDate: '2026-07-14',
      currentDueDate: '2026-08-21',
    });
    database.settleTransaction(database.listTransactions({ month: '2026-08' })[0].id);

    const corrected = database.saveInstallmentPurchase({
      id: purchase.id,
      description: 'Oboticário',
      installmentAmount: 55.16,
      totalInstallments: 10,
      currentInstallment: 4,
      originalCurrentInstallment: 5,
      purchaseDate: '2026-07-14',
      currentDueDate: '2026-08-21',
    });

    expect(corrected).toMatchObject({
      startingInstallment: 4,
      viewedInstallment: 4,
      viewedStatus: 'paid',
      paidInstallments: 4,
      firstDueDate: '2026-05-21',
    });
    expect(database.listTransactions({ month: '2026-08' })[0]).toMatchObject({
      installmentNumber: 4,
      installmentTotal: 10,
      dueDate: '2026-08-21',
      status: 'paid',
      actualAmount: 55.16,
    });
    expect(database.listTransactions({ month: '2026-09' })[0]).toMatchObject({
      installmentNumber: 5,
      dueDate: '2026-09-21',
      status: 'planned',
    });
    expect(database.listTransactions({ month: '2027-02' })[0]).toMatchObject({
      installmentNumber: 10,
      dueDate: '2027-02-21',
      status: 'planned',
    });
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

  it('combina filtros de cartão de crédito e compra parcelada', () => {
    const database = createDatabase();
    const credit = database.getCatalogs().paymentMethods.find((method) => method.name === 'Cartão de crédito');
    database.createCatalogItem({ type: 'card', name: 'Nubank', dueDay: 21, closingDay: 14 });
    const card = database.getCatalogs().cards[0];

    database.saveTransaction({
      kind: 'expense',
      description: 'Assinatura no cartão',
      plannedAmount: 50,
      dueDate: '2026-08-21',
      status: 'planned',
      paymentMethodId: credit?.id ?? null,
      cardId: card.id,
    });
    database.saveTransaction({
      kind: 'expense',
      description: 'Conta no Pix',
      plannedAmount: 80,
      dueDate: '2026-08-21',
      status: 'planned',
      paymentMethodId: null,
    });
    database.createInstallmentPurchase({
      description: 'Notebook parcelado',
      cardId: card.id,
      paymentMethodId: credit?.id ?? null,
      installmentAmount: 200,
      totalInstallments: 3,
      currentInstallment: 1,
      purchaseDate: '2026-07-10',
      currentDueDate: '2026-08-21',
    });

    expect(database.listTransactions({ month: '2026-08', payment: 'creditCard' }).map((item) => item.description))
      .toEqual(['Assinatura no cartão', 'Notebook parcelado']);
    expect(database.listTransactions({ month: '2026-08', source: 'installment' }).map((item) => item.description))
      .toEqual(['Notebook parcelado']);
    expect(database.listTransactions({ month: '2026-08', payment: 'creditCard', source: 'installment' }).map((item) => item.description))
      .toEqual(['Notebook parcelado']);
    expect(database.listTransactions({ month: '2026-08', payment: 'other' }).map((item) => item.description))
      .toEqual(['Conta no Pix']);
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
  it('quita a lista inteira usando o planejado e a data real do pagamento', () => {
    const database = createDatabase();
    const internet = plan(database, 'expense', 'Internet', '2020-03-10', 120);
    const salary = plan(database, 'income', 'Salário CLT', '2020-03-05', 4000);
    const future = plan(database, 'expense', 'Luz', '2999-03-20', 300);
    database.settleTransaction(future.id);

    const settled = database.settleTransactions([internet.id, salary.id, future.id]);

    // A conta futura já estava quitada e não entra na contagem.
    expect(settled).toBe(2);
    expect(database.listTransactions({ month: '2020-03' })).toMatchObject([
      { description: 'Salário CLT', status: 'received', actualAmount: 4000, settledDate: todayIso() },
      { description: 'Internet', status: 'paid', actualAmount: 120, settledDate: todayIso() },
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
  it('mostra despesas do mês aberto e prioriza atrasos carregados', () => {
    const database = createDatabase();
    const month = currentMonthIso();
    const previousMonth = addMonths(`${month}-01`, -1).slice(0, 7);
    const nextMonth = addMonths(`${month}-01`, 1).slice(0, 7);
    plan(database, 'expense', 'Internet atrasada', `${previousMonth}-10`, 120);
    plan(database, 'expense', 'Luz', `${month}-20`, 600);
    plan(database, 'income', 'Salário CLT', `${month}-05`, 1489);
    plan(database, 'expense', 'Internet futura', `${nextMonth}-10`, 120);

    const { upcoming } = database.getOverview(month);

    expect(upcoming.map((item) => item.description)).toEqual(['Internet atrasada', 'Luz']);
    expect(upcoming[0].isOverdue).toBe(true);

    database.db.close();
  });

  it('deixa de listar a conta depois que ela é paga', () => {
    const database = createDatabase();
    const month = currentMonthIso();
    const bill = plan(database, 'expense', 'Internet', `${month}-20`, 120);

    expect(database.getOverview(month).upcoming).toHaveLength(1);

    database.settleTransaction(bill.id);

    expect(database.getOverview(month).upcoming).toEqual([]);

    database.db.close();
  });
});

describe('contas vencidas carregadas adiante', () => {
  it('preserva o vencimento, tira do total antigo e carrega junto da recorrência normal', () => {
    const database = createDatabase();
    const month = currentMonthIso();
    const previousMonth = addMonths(`${month}-01`, -1).slice(0, 7);
    const nextMonth = addMonths(`${month}-01`, 1).slice(0, 7);
    database.saveRecurringExpense({
      kind: 'expense',
      active: true,
      description: 'Moto',
      startMonth: previousMonth,
      plannedAmount: 555.12,
      dueDay: 1,
      notes: '',
    });

    const original = database.listTransactions({ month: previousMonth })
      .find((item) => item.dueDate.startsWith(previousMonth));
    if (!original) throw new Error('A ocorrência original não foi criada.');
    const currentItems = database.listTransactions({ month });
    const carried = currentItems.find((item) => item.id === original.id);
    const regular = currentItems.find((item) => item.sourceId === original.sourceId && item.dueDate.startsWith(month));

    expect(carried).toMatchObject({
      description: 'Moto',
      dueDate: `${previousMonth}-01`,
      status: 'planned',
      isOverdue: true,
    });
    expect(regular).toMatchObject({ description: 'Moto', dueDate: `${month}-01` });
    expect(database.getOverview(previousMonth).summary).toMatchObject({
      plannedExpenses: 0,
      paidExpenses: 0,
      overdueExpenses: 0,
    });
    expect(database.getOverview(month).summary.plannedExpenses).toBe(1110.24);
    expect(database.listTransactions({ month: nextMonth }).some((item) => item.id === original.id)).toBe(true);

    database.settleTransaction(original.id);

    const paid = database.listTransactions({ month }).find((item) => item.id === original.id);
    expect(paid).toMatchObject({
      dueDate: `${previousMonth}-01`,
      settledDate: todayIso(),
      status: 'paid',
      isOverdue: false,
    });
    expect(database.getOverview(month).summary).toMatchObject({
      plannedExpenses: 1110.24,
      paidExpenses: 555.12,
    });
    expect(database.listTransactions({ month: nextMonth }).some((item) => item.id === original.id)).toBe(false);
    expect(database.listTransactions({ month: previousMonth }).some((item) => item.id === original.id)).toBe(true);
    database.db.close();
  });

  it('não carrega entradas, canceladas, futuras ou contas já pagas', () => {
    const database = createDatabase();
    const month = currentMonthIso();
    const previousMonth = addMonths(`${month}-01`, -1).slice(0, 7);
    const nextMonth = addMonths(`${month}-01`, 1).slice(0, 7);
    const overdue = plan(database, 'expense', 'Conta vencida', `${previousMonth}-05`, 100);
    plan(database, 'income', 'Entrada vencida', `${previousMonth}-05`, 200);
    database.saveTransaction({
      ...plan(database, 'expense', 'Conta cancelada', `${previousMonth}-06`, 300),
      dueDate: `${previousMonth}-06`,
      status: 'cancelled',
    });
    plan(database, 'expense', 'Conta futura', `${nextMonth}-20`, 400);
    const paid = plan(database, 'expense', 'Conta paga', `${previousMonth}-07`, 500);
    database.settleTransaction(paid.id);

    const carriedIds = database.listTransactions({ month: nextMonth }).map((item) => item.id);
    expect(carriedIds).toContain(overdue.id);
    expect(carriedIds).not.toContain(paid.id);
    expect(database.listTransactions({ month: nextMonth }).filter((item) => item.dueDate.startsWith(previousMonth)))
      .toHaveLength(1);
    database.db.close();
  });
});
