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
