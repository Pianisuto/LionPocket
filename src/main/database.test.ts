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
      active: true,
      description: 'Internet antiga',
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
