import {
  isValidDate,
  validateMonth,
  type BackupData,
  type BackupRow,
  type LocalBackup,
} from '@lionpocket/core';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { migrations, migrate } from './migrations';
import type { Connection, Query } from './planningRepository';

// Trusted identifiers only. Imported SQL/schema is never executed in the live database.
export const backupTables = [
  'categories',
  'payment_methods',
  'cards',
  'recurring_expenses',
  'installment_purchases',
  'transactions',
  'goals',
  'recurring_transaction_priorities',
  'transaction_priority_order',
  'local_import_records',
  'local_preferences',
] as const;
const columns: Record<string, string[]> = {
  categories: ['id', 'name', 'kind', 'color'],
  payment_methods: ['id', 'name'],
  cards: ['id', 'name', 'due_day', 'closing_day'],
  transactions: [
    'id',
    'kind',
    'description',
    'planned_amount_cents',
    'actual_amount_cents',
    'due_date',
    'settled_date',
    'status',
    'notes',
    'created_at',
    'category_id',
    'payment_method_id',
    'card_id',
    'purchase_date',
    'updated_at',
    'deleted_at',
    'source_type',
    'source_id',
    'installment_number',
    'installment_total',
    'occurrence_date',
  ],
  recurring_expenses: [
    'id',
    'kind',
    'active',
    'description',
    'start_month',
    'start_date',
    'frequency',
    'interval_count',
    'interval_unit',
    'anchor_to_actual',
    'manual_months',
    'category_id',
    'payment_method_id',
    'card_id',
    'planned_amount_cents',
    'due_day',
    'charge_day',
    'notes',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  installment_purchases: [
    'id',
    'description',
    'category_id',
    'payment_method_id',
    'card_id',
    'installment_amount_cents',
    'total_installments',
    'starting_installment',
    'purchase_date',
    'first_due_date',
    'status',
    'notes',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  goals: [
    'id',
    'name',
    'item_model',
    'link',
    'category_id',
    'target_amount_cents',
    'saved_amount_cents',
    'priority',
    'due_date',
    'status',
    'notes',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  recurring_transaction_priorities: [
    'recurring_id',
    'position',
    'pinned_from_month',
    'created_at',
    'updated_at',
  ],
  transaction_priority_order: [
    'month',
    'transaction_id',
    'position',
    'created_at',
    'updated_at',
  ],
  local_import_records: ['source_key', 'created_at'],
  local_preferences: ['key', 'value'],
};
export function tablesForVersion(version: number): string[] {
  if (!Number.isInteger(version) || version < 1)
    throw new Error('O arquivo não é um banco do LionPocket Mobile.');
  if (version > migrations.length)
    throw new Error(
      'O banco foi criado por uma versão mais nova do LionPocket.',
    );
  return backupTables.filter(
    (t) =>
      (t !== 'local_preferences' || version >= 5) &&
      (version === 1
        ? t === 'transactions'
        : version === 2
          ? ['categories', 'payment_methods', 'cards', 'transactions'].includes(
              t,
            )
          : version === 3
            ? ![
                'recurring_transaction_priorities',
                'transaction_priority_order',
                'local_import_records',
              ].includes(t)
            : true),
  );
}
function columnsForVersion(table: string, version: number) {
  if (table === 'transactions')
    return version === 1
      ? columns.transactions.slice(0, 10)
      : version === 2
        ? columns.transactions.slice(0, 16)
        : columns.transactions;
  return columns[table];
}
export async function verifyDatabase(
  db: Query,
  version: number,
): Promise<void> {
  const tables = tablesForVersion(version);
  const objects = (
    await db.executeAsync<{ name: string; type: string }>(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type != 'index'",
    )
  ).rows._array;
  if (
    objects.some((o) => o.type !== 'table' || !tables.includes(o.name)) ||
    tables.some((t) => !objects.some((o) => o.name === t))
  )
    throw new Error(
      'Estrutura de banco incompatível. Use um backup SQLite do Mobile ou importe o JSON do desktop.',
    );
  for (const table of tables) {
    const actual = (
      await db.executeAsync<{ name: string }>(`PRAGMA table_info(${table})`)
    ).rows._array.map((r) => r.name);
    const expected = columnsForVersion(table, version);
    if (
      actual.length !== expected.length ||
      expected.some((name) => !actual.includes(name))
    )
      throw new Error(`Estrutura incompatível: ${table}.`);
  }
  const check = (await db.executeAsync<BackupRow>('PRAGMA integrity_check'))
    .rows._array;
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok')
    throw new Error('O backup está corrompido.');
  if ((await db.executeAsync('PRAGMA foreign_key_check')).rows._array.length)
    throw new Error('O backup possui referências inválidas.');
}
export async function captureBackup(db: Connection): Promise<LocalBackup> {
  return db.transaction(async (tx) => {
    const version = Number(
      (await tx.executeAsync<{ user_version: number }>('PRAGMA user_version'))
        .rows._array[0].user_version,
    );
    const data: BackupData = {};
    for (const table of tablesForVersion(version))
      data[table] = (
        await tx.executeAsync<BackupRow>(`SELECT * FROM ${table}`)
      ).rows._array;
    return {
      version: 1,
      platform: 'mobile',
      schemaVersion: version,
      exportedAt: new Date().toISOString(),
      data,
    };
  });
}
function validateRows(data: BackupData, version: number) {
  const tables = tablesForVersion(version);
  if (
    Object.keys(data).some((t) => !tables.includes(t)) ||
    tables.some((t) => !Array.isArray(data[t]))
  )
    throw new Error('O arquivo não contém todas as tabelas esperadas.');
  for (const table of tables)
    for (const row of data[table]) {
      const keys = Object.keys(row),
        expected = columnsForVersion(table, version);
      if (
        keys.length !== expected.length ||
        keys.some((k) => !expected.includes(k))
      )
        throw new Error(`Colunas inválidas: ${table}.`);
      if (
        Object.values(row).some(
          (v) =>
            v !== null &&
            typeof v !== 'string' &&
            (typeof v !== 'number' || !Number.isFinite(v)),
        )
      )
        throw new Error('Dados inválidos no backup.');
      for (const [key, value] of Object.entries(row)) {
        if (
          key.endsWith('_cents') &&
          value != null &&
          (!Number.isSafeInteger(value) || Number(value) < 0)
        )
          throw new Error('Valor monetário inválido no backup.');
        if (
          [
            'due_date',
            'purchase_date',
            'settled_date',
            'first_due_date',
            'start_date',
            'occurrence_date',
          ].includes(key) &&
          value != null &&
          !isValidDate(String(value))
        )
          throw new Error(`Data inválida: ${table}.${key}.`);
      }
      if (row.month) validateMonth(String(row.month));
      if (row.start_month) validateMonth(String(row.start_month));
    }
}
/** Call on a disposable staging database, never on the live database for unverified input. */
export async function loadBackupData(
  db: NitroSQLiteConnection,
  data: BackupData,
  version: number,
) {
  validateRows(data, version);
  for (const migration of migrations.slice(0, version))
    for (const sql of migration) await db.executeAsync(sql);
  await db.executeAsync(`PRAGMA user_version = ${version}`);
  await db.transaction((tx) => replaceRows(tx, data, version));
  await verifyDatabase(db, version);
  await migrate(db);
  return captureBackup(db);
}
async function replaceRows(tx: Query, data: BackupData, version: number) {
  const tables = tablesForVersion(version);
  for (const table of [...tables].reverse())
    await tx.executeAsync(`DELETE FROM ${table}`);
  // Priorities follow their referenced transactions and series.
  for (const table of tables)
    for (const row of data[table]) {
      const keys = columnsForVersion(table, version);
      await tx.executeAsync(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map((k) => row[k]),
      );
    }
  if ((await tx.executeAsync('PRAGMA foreign_key_check')).rows._array.length)
    throw new Error('Há referências inválidas no arquivo.');
}
/** Atomic replacement of validated records; schema/connection stay current after old backups. */
export async function restoreBackup(
  db: Connection,
  backup: LocalBackup,
  protectCurrent: () => Promise<void>,
) {
  if (backup.schemaVersion !== migrations.length)
    throw new Error('Migre a cópia antes de restaurar.');
  validateRows(backup.data, backup.schemaVersion);
  await protectCurrent(); // A failure to save the recovery copy must abort replacement.
  await db.transaction((tx) =>
    replaceRows(tx, backup.data, backup.schemaVersion),
  );
}
