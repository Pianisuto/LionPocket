import { fromCents, toCents, todayIso } from '@lionpocket/core/finance';
import type { Transaction, TransactionInput } from '@lionpocket/core/types';
import { open, type NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { migrate } from './migrations';

type TransactionRow = {
  id: string;
  kind: Transaction['kind'];
  description: string;
  planned_amount_cents: number;
  actual_amount_cents: number | null;
  due_date: string;
  settled_date: string | null;
  status: Transaction['status'];
  notes: string;
};

let databasePromise: Promise<NitroSQLiteConnection> | undefined;

async function database(): Promise<NitroSQLiteConnection> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = open({ name: 'lionpocket.sqlite' });
      await migrate(db);
      return db;
    })().catch(error => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

function fromRow(row: TransactionRow): Transaction {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    plannedAmount: fromCents(row.planned_amount_cents) ?? 0,
    actualAmount: fromCents(row.actual_amount_cents),
    purchaseDate: null,
    dueDate: row.due_date,
    settledDate: row.settled_date,
    status: row.status,
    paymentMethodId: null,
    paymentMethodName: null,
    cardId: null,
    cardName: null,
    notes: row.notes,
    sourceType: 'manual',
    sourceId: null,
    installmentNumber: null,
    installmentTotal: null,
    isOverdue: row.status === 'planned' && row.due_date < todayIso(),
    priorityPosition: null,
  };
}

export async function listTransactions(): Promise<Transaction[]> {
  const db = await database();
  const { rows } = await db.executeAsync<TransactionRow>(
    `SELECT id, kind, description, planned_amount_cents, actual_amount_cents,
            due_date, settled_date, status, notes
     FROM transactions
     ORDER BY due_date DESC, created_at DESC, id DESC`,
  );
  return rows._array.map(fromRow);
}

export async function createTransaction(input: TransactionInput): Promise<void> {
  const db = await database();
  const plannedCents = toCents(input.plannedAmount);
  const actualCents = toCents(input.actualAmount);
  if (!plannedCents || plannedCents <= 0) {
    throw new Error('Informe um valor maior que zero.');
  }
  const { rows } = await db.executeAsync<{ id: string }>(
    'SELECT lower(hex(randomblob(16))) AS id',
  );
  const id = rows._array[0]?.id;
  if (!id) throw new Error('Não foi possível gerar o identificador do lançamento.');

  await db.executeAsync(
    `INSERT INTO transactions
      (id, kind, description, planned_amount_cents, actual_amount_cents,
       due_date, settled_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.description.trim(),
      plannedCents,
      actualCents,
      input.dueDate,
      input.settledDate ?? null,
      input.status,
      input.notes ?? '',
    ],
  );
}
