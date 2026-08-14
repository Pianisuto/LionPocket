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

describe('contas a caminho', () => {
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
