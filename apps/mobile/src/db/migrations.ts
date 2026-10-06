import { syncMigration, transportMigration, financialMigration, financialTriggers, financialTableTypes } from '@lionpocket/sync-local';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { seedNewCatalogs } from './catalogDefaults';

const previousMigrations: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE transactions (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      description TEXT NOT NULL,
      planned_amount_cents INTEGER NOT NULL CHECK (planned_amount_cents > 0),
      actual_amount_cents INTEGER,
      due_date TEXT NOT NULL,
      settled_date TEXT,
      status TEXT NOT NULL CHECK (status IN ('planned', 'paid', 'received', 'cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX transactions_due_date_idx ON transactions (due_date DESC, created_at DESC)',
  ],
  [
    `CREATE TABLE categories (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')), color TEXT NOT NULL,
      UNIQUE(name, kind))`,
    `CREATE TABLE payment_methods (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE)`,
    `CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
      due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
      closing_day INTEGER CHECK (closing_day BETWEEN 1 AND 31))`,
    'ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(id)',
    'ALTER TABLE transactions ADD COLUMN payment_method_id TEXT REFERENCES payment_methods(id)',
    'ALTER TABLE transactions ADD COLUMN card_id TEXT REFERENCES cards(id)',
    'ALTER TABLE transactions ADD COLUMN purchase_date TEXT',
    'ALTER TABLE transactions ADD COLUMN updated_at TEXT',
    'ALTER TABLE transactions ADD COLUMN deleted_at TEXT',
    `INSERT INTO categories VALUES
      ('cat-food', 'Alimentação', 'expense', '#f5b65b'),
      ('cat-home', 'Moradia', 'expense', '#8f8bff'),
      ('cat-transport', 'Transporte', 'expense', '#73b9ff'),
      ('cat-health', 'Saúde', 'expense', '#ed82ab'),
      ('cat-leisure', 'Lazer', 'expense', '#9fdb89'),
      ('cat-other-expense', 'Outras saídas', 'expense', '#aaaebc'),
      ('cat-salary', 'Salário', 'income', '#69d4b0'),
      ('cat-other-income', 'Outras entradas', 'income', '#73b9ff')`,
    `INSERT INTO payment_methods VALUES
      ('payment-pix', 'Pix'), ('payment-cash', 'Dinheiro'), ('payment-debit', 'Débito'),
      ('payment-credit', 'Cartão de crédito'), ('payment-boleto', 'Boleto'),
      ('payment-transfer', 'Transferência')`,
    'CREATE INDEX transactions_status_idx ON transactions (status, due_date)',
  ],
  [
    "ALTER TABLE transactions ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'",
    'ALTER TABLE transactions ADD COLUMN source_id TEXT',
    'ALTER TABLE transactions ADD COLUMN installment_number INTEGER',
    'ALTER TABLE transactions ADD COLUMN installment_total INTEGER',
    // Stable identity survives changing the due date of an individual occurrence.
    'ALTER TABLE transactions ADD COLUMN occurrence_date TEXT',
    `CREATE TABLE recurring_expenses (
      id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
      active INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL,
      start_month TEXT NOT NULL, start_date TEXT NOT NULL, frequency TEXT NOT NULL,
      interval_count INTEGER NOT NULL DEFAULT 1, interval_unit TEXT NOT NULL DEFAULT 'months',
      anchor_to_actual INTEGER NOT NULL DEFAULT 0, manual_months TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id),
      card_id TEXT REFERENCES cards(id), planned_amount_cents INTEGER NOT NULL CHECK(planned_amount_cents > 0),
      due_day INTEGER NOT NULL, charge_day INTEGER, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
    )`,
    `CREATE TABLE installment_purchases (
      id TEXT PRIMARY KEY NOT NULL, description TEXT NOT NULL,
      category_id TEXT REFERENCES categories(id), payment_method_id TEXT REFERENCES payment_methods(id),
      card_id TEXT REFERENCES cards(id), installment_amount_cents INTEGER NOT NULL CHECK(installment_amount_cents > 0),
      total_installments INTEGER NOT NULL CHECK(total_installments > 0), starting_installment INTEGER NOT NULL DEFAULT 1,
      purchase_date TEXT, first_due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, deleted_at TEXT
    )`,
    `CREATE TABLE goals (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, item_model TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
      category_id TEXT REFERENCES categories(id), target_amount_cents INTEGER NOT NULL CHECK(target_amount_cents > 0),
      saved_amount_cents INTEGER NOT NULL CHECK(saved_amount_cents >= 0), priority TEXT NOT NULL, due_date TEXT,
      status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT, deleted_at TEXT
    )`,
    `CREATE UNIQUE INDEX transactions_generated_due_unique ON transactions(source_type, source_id, due_date)
      WHERE source_type != 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL`,
    `CREATE UNIQUE INDEX transactions_recurring_effective_unique ON transactions(source_id, COALESCE(purchase_date, due_date))
      WHERE source_type = 'recurring' AND source_id IS NOT NULL AND deleted_at IS NULL`,
    `CREATE UNIQUE INDEX transactions_recurring_occurrence_unique ON transactions(source_id, occurrence_date)
      WHERE source_type = 'recurring' AND occurrence_date IS NOT NULL`,
    'CREATE INDEX transactions_source_idx ON transactions(source_type, source_id)',
  ],
  [
    `CREATE TABLE recurring_transaction_priorities (
      recurring_id TEXT PRIMARY KEY NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
      position INTEGER NOT NULL UNIQUE CHECK(position >= 0), pinned_from_month TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE transaction_priority_order (
      month TEXT NOT NULL, transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(month, transaction_id), UNIQUE(month, position)
    )`,
    `CREATE TABLE local_import_records (source_key TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL)`,
  ],
];

// SQLite cannot ALTER an existing CHECK constraint. Rebuild only the three monetary
// tables inside one transaction, keeping every column, identity and child priority row.
// Versions 1–4 remain byte-for-byte unchanged for historical restore.
const rebuiltTables = [
  'transactions',
  'recurring_expenses',
  'goals',
  'recurring_transaction_priorities',
  'transaction_priority_order',
];
const parityMigration = [
  ...rebuiltTables.map(
    (table) => `CREATE TEMP TABLE parity_${table} AS SELECT * FROM ${table}`,
  ),
  ...[...rebuiltTables].reverse().map((table) => `DROP TABLE ${table}`),
  ...previousMigrations
    .flat()
    .filter(
      (sql) =>
        rebuiltTables.some((table) =>
          sql.startsWith(`CREATE TABLE ${table} (`),
        ) ||
        sql.startsWith('ALTER TABLE transactions') ||
        sql.startsWith('CREATE INDEX transactions_') ||
        sql.startsWith('CREATE UNIQUE INDEX transactions_'),
    )
    .map((sql) =>
      sql
        .replaceAll('planned_amount_cents > 0', 'planned_amount_cents >= 0')
        .replaceAll('planned_amount_cents>0', 'planned_amount_cents>=0')
        .replaceAll('target_amount_cents > 0', 'target_amount_cents >= 0')
        .replaceAll('target_amount_cents>0', 'target_amount_cents>=0'),
    ),
  ...rebuiltTables.map(
    (table) => `INSERT INTO ${table} SELECT * FROM parity_${table}`,
  ),
  ...rebuiltTables.map((table) => `DROP TABLE parity_${table}`),
  `CREATE TABLE local_preferences (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
];
// The financial protocol permits an unknown historical start date. Keep that
// value instead of changing the schedule while receiving a Desktop baseline.
const nullableScheduleMigration = [
  'CREATE TEMP TABLE schedule_recurring AS SELECT * FROM recurring_expenses',
  'CREATE TEMP TABLE schedule_priorities AS SELECT * FROM recurring_transaction_priorities',
  'DROP TABLE recurring_transaction_priorities',
  'DROP TABLE recurring_expenses',
  ...parityMigration.filter(sql => sql.startsWith('CREATE TABLE recurring_expenses ('))
    .map(sql => sql.replace('start_date TEXT NOT NULL', 'start_date TEXT')),
  ...previousMigrations.flat().filter(sql => sql.startsWith('CREATE TABLE recurring_transaction_priorities (')),
  'INSERT INTO recurring_expenses SELECT * FROM schedule_recurring',
  'INSERT INTO recurring_transaction_priorities SELECT * FROM schedule_priorities',
  'DROP TABLE schedule_priorities',
  'DROP TABLE schedule_recurring',
  'DROP INDEX transactions_recurring_occurrence_unique',
  `CREATE UNIQUE INDEX transactions_recurring_occurrence_unique ON transactions(source_id, occurrence_date)
    WHERE source_type = 'recurring' AND occurrence_date IS NOT NULL AND deleted_at IS NULL`,
];
export const migrations: ReadonlyArray<ReadonlyArray<string>> = [
  ...previousMigrations,
  parityMigration,
  syncMigration,
  transportMigration,
  financialMigration,
  nullableScheduleMigration,
];

export async function migrate(
  db: NitroSQLiteConnection,
  protectCurrent?: () => Promise<void>,
): Promise<void> {
  const { rows } = await db.executeAsync<{ user_version: number }>(
    'PRAGMA user_version',
  );
  const currentVersion = Number(rows._array[0]?.user_version ?? 0);
  if (currentVersion > migrations.length) {
    throw new Error(
      'O banco foi criado por uma versão mais nova do LionPocket.',
    );
  }

  if (currentVersion > 0 && currentVersion < migrations.length && protectCurrent)
    await protectCurrent();

  for (let index = currentVersion; index < migrations.length; index += 1) {
    await db.transaction(async (tx) => {
      for (const statement of migrations[index]) {
        await tx.executeAsync(statement);
      }
      if (currentVersion === 0 && index === 4) {
        await seedNewCatalogs({
          executeAsync: tx.executeAsync.bind(tx),
          transaction: async (action) => action(tx),
        });
      }
      if (
        (await tx.executeAsync('PRAGMA foreign_key_check')).rows._array.length
      )
        throw new Error(
          'A atualização não pôde preservar as referências do banco.',
        );
      if (index >= 7) {
        const columns: Record<string, string[]> = {};
        for (const table of Object.keys(financialTableTypes)) columns[table] = (await tx.executeAsync<{ name: string }>(`PRAGMA table_info(${table})`)).rows._array.map(r => r.name);
        for (const table of Object.keys(financialTableTypes))
          for (const action of ['insert', 'update', 'delete'])
            await tx.executeAsync(`DROP TRIGGER IF EXISTS sync_capture_${table}_${action}`);
        for (const statement of financialTriggers('android', columns)) await tx.executeAsync(statement);
      }
      await tx.executeAsync(`PRAGMA user_version = ${index + 1}`);
    });
  }
}
