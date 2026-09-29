import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { summarizeMonth } from '@lionpocket/core';
import type { TransactionInput } from '@lionpocket/core';
import { migrate, migrations } from './migrations';
import { MobileRepository } from './repository';

const connections: DatabaseSync[] = [];
function connection() {
  const sqlite = new DatabaseSync(':memory:');
  connections.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const executeAsync = async (sql: string, params: (string | number | null)[] = []) => {
    const statement = sqlite.prepare(sql);
    const rows = statement.all(...params);
    const result = sqlite.prepare('SELECT changes() AS changes').get();
    return { rows: { _array: rows }, rowsAffected: Number(result?.changes ?? 0) };
  };
  const db = {
    executeAsync,
    transaction: async (action: (tx: { executeAsync: typeof executeAsync }) => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await action({ executeAsync });
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as NitroSQLiteConnection;
  return { sqlite, db };
}
const input = (changes: Partial<TransactionInput> = {}): TransactionInput => ({
  kind: 'expense',
  description: 'Mercado',
  plannedAmount: 100,
  dueDate: '2026-09-30',
  status: 'planned',
  ...changes,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
  connections.splice(0).forEach((db) => db.close());
});

describe('migrations SQLite mobile', () => {
  it('preserva registros da versão 1 e aplica todas as versões apenas uma vez', async () => {
    const { sqlite, db } = connection();
    migrations[0].forEach((sql) => sqlite.exec(sql));
    sqlite.exec(`PRAGMA user_version = 1;
      INSERT INTO transactions (id, kind, description, planned_amount_cents, actual_amount_cents, due_date, settled_date, status, notes)
      VALUES ('legacy', 'income', 'Salário antigo', 123456, 123400, '2026-08-10', '2026-08-11', 'received', 'Preservar');`);
    await migrate(db);
    await migrate(db);
    const repository = new MobileRepository(db);
    const items = await repository.list({ month: '2026-08' });
    expect(items[0]).toMatchObject({
      id: 'legacy',
      description: 'Salário antigo',
      plannedAmount: 1234.56,
      actualAmount: 1234,
      notes: 'Preservar',
      categoryId: null,
      settledDate: '2026-08-11',
    });
    expect((await repository.catalogs()).categories).toHaveLength(8);
    expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: migrations.length,
    });
  });
  it('recusa um banco futuro sem modificá-lo', async () => {
    const { sqlite, db } = connection();
    sqlite.exec('PRAGMA user_version = 99');
    await expect(migrate(db)).rejects.toThrow('mais nova');
    expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 99,
    });
  });
  it('reverte uma migration incompleta', async () => {
    const { sqlite, db } = connection();
    migrations[0].forEach((sql) => sqlite.exec(sql));
    sqlite.exec('PRAGMA user_version = 1; CREATE TABLE cards (id TEXT)');
    await expect(migrate(db)).rejects.toThrow();
    expect(sqlite.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 1,
    });
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'categories'").all(),
    ).toEqual([]);
  });
});

describe('uso financeiro diário em SQLite', () => {
  it('cria, associa, edita, paga, filtra e exclui sem perder valores ou relações', async () => {
    const { db, sqlite } = connection();
    await migrate(db);
    const repository = new MobileRepository(db);
    await repository.createCatalog({
      type: 'card',
      name: 'Meu cartão',
      closingDay: 20,
      dueDay: 5,
    });
    const cardId = (await repository.catalogs()).cards[0].id;
    await repository.save(
      input({
        categoryId: 'cat-food',
        paymentMethodId: 'payment-credit',
        cardId,
        purchaseDate: '2026-09-18',
      }),
    );
    let [item] = await repository.list({ month: '2026-09' });
    expect(item).toMatchObject({
      categoryName: 'Alimentação',
      paymentMethodName: 'Cartão de crédito',
      cardName: 'Meu cartão',
      actualAmount: null,
    });
    await repository.save(input({ ...item, description: 'Mercado editado', actualAmount: 95.35 }));
    await repository.settle(item.id);
    [item] = await repository.list({
      month: '2026-09',
      kind: 'expense',
      status: 'paid',
    });
    expect(item).toMatchObject({
      description: 'Mercado editado',
      actualAmount: 95.35,
      plannedAmount: 100,
      settledDate: '2026-09-29',
      status: 'paid',
      cardId,
    });
    expect(summarizeMonth([item], '2026-09')).toMatchObject({
      paidExpenses: 95.35,
      plannedExpenses: 100,
      realizedBalance: -95.35,
    });
    expect(await repository.list({ month: '2026-09', kind: 'income' })).toEqual([]);
    expect(await repository.list({ month: '2026-09', status: 'planned' })).toEqual([]);
    await expect(repository.settle(item.id)).rejects.toThrow('pendente');
    await repository.remove(item.id);
    expect(await repository.list({ month: '2026-09' })).toEqual([]);
    expect(
      sqlite.prepare('SELECT planned_amount_cents, deleted_at FROM transactions').get(),
    ).toMatchObject({
      planned_amount_cents: 10000,
      deleted_at: expect.any(String),
    });
    await expect(repository.save(input({ id: item.id }))).rejects.toThrow('não encontrado');
  });
  it('recebe receitas, transporta atrasos e atribui pagamentos tardios ao mês correto', async () => {
    const { db } = connection();
    await migrate(db);
    const repository = new MobileRepository(db);
    await repository.save(
      input({
        kind: 'income',
        description: 'Salário',
        dueDate: '2026-09-10',
        plannedAmount: 3000,
      }),
    );
    const income = (await repository.list({ month: '2026-09', kind: 'income' }))[0];
    expect(income.isOverdue).toBe(false);
    await repository.settle(income.id);
    expect((await repository.list({ month: '2026-09', status: 'received' }))[0]).toMatchObject({
      actualAmount: 3000,
      status: 'received',
    });
    await repository.save(input({ dueDate: '2026-08-15' }));
    const expense = (await repository.list({ month: '2026-09', kind: 'expense' }))[0];
    expect(expense.isOverdue).toBe(true);
    expect(
      summarizeMonth(await repository.list({ month: '2026-08' }), '2026-08').plannedExpenses,
    ).toBe(0);
    await repository.settle(expense.id);
    expect(summarizeMonth(await repository.list({ month: '2026-09' }), '2026-09')).toMatchObject({
      receivedIncome: 3000,
      paidExpenses: 100,
      realizedBalance: 2900,
    });
    expect(
      summarizeMonth(await repository.list({ month: '2026-08' }), '2026-08').paidExpenses,
    ).toBe(0);
  });
  it('move um lançamento entre meses e permite reabrir ou cancelar', async () => {
    const { db } = connection();
    await migrate(db);
    const repository = new MobileRepository(db);
    await repository.save(input());
    const item = (await repository.list({ month: '2026-09' }))[0];
    await repository.save(
      input({
        id: item.id,
        dueDate: '2026-10-02',
        status: 'paid',
        actualAmount: 80,
        settledDate: '2026-10-02',
      }),
    );
    expect(await repository.list({ month: '2026-09' })).toHaveLength(0);
    expect((await repository.list({ month: '2026-10' }))[0]).toMatchObject({
      status: 'paid',
      actualAmount: 80,
    });
    await repository.save(input({ id: item.id, dueDate: '2026-10-02' }));
    expect((await repository.list({ month: '2026-10' }))[0]).toMatchObject({
      status: 'planned',
      settledDate: null,
    });
    await repository.save(input({ id: item.id, dueDate: '2026-10-02', status: 'cancelled' }));
    expect(
      summarizeMonth(await repository.list({ month: '2026-10' }), '2026-10').plannedExpenses,
    ).toBe(0);
  });
  it('associa categorias e pagamentos personalizados e aceita realizado zero', async () => {
    const { db } = connection();
    await migrate(db);
    const repository = new MobileRepository(db);
    await repository.createCatalog({ type: 'category', name: 'Educação', kind: 'expense' });
    await repository.createCatalog({ type: 'paymentMethod', name: 'Pagamento personalizado' });
    const catalogs = await repository.catalogs();
    const categoryId = catalogs.categories.find((item) => item.name === 'Educação')?.id;
    const paymentMethodId = catalogs.paymentMethods.find(
      (item) => item.name === 'Pagamento personalizado',
    )?.id;
    expect(categoryId).toBeTruthy();
    expect(paymentMethodId).toBeTruthy();
    await repository.save(
      input({
        categoryId,
        paymentMethodId,
        status: 'paid',
        actualAmount: 0,
        settledDate: '2026-09-29',
      }),
    );
    const items = await repository.list({ month: '2026-09' });
    expect(items[0]).toMatchObject({
      categoryName: 'Educação',
      paymentMethodName: 'Pagamento personalizado',
      actualAmount: 0,
    });
    expect(summarizeMonth(items, '2026-09')).toMatchObject({
      plannedExpenses: 100,
      paidExpenses: 0,
    });
  });

  it('valida entradas de domínio e referências antes de persistir', async () => {
    const { db } = connection();
    await migrate(db);
    const repository = new MobileRepository(db);
    for (const changes of [
      { categoryId: 'cat-salary' },
      { cardId: 'unknown' },
      { paymentMethodId: 'unknown' },
      { description: '  ' },
      { dueDate: '2026-02-30' },
      { plannedAmount: Infinity },
      { kind: 'income' as const, status: 'paid' as const },
    ]) {
      await expect(repository.save(input(changes))).rejects.toThrow();
    }
    await expect(
      repository.createCatalog({ type: 'card', name: 'Inválido', dueDay: 0 }),
    ).rejects.toThrow();
    await expect(repository.createCatalog({ type: 'paymentMethod', name: 'Pix' })).rejects.toThrow(
      'Já existe',
    );
    expect(await repository.list({ month: '2026-09' })).toEqual([]);
  });
});
