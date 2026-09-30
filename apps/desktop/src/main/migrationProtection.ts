import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const desktopSchemaVersion = 11;

/** No sync metadata. Protect the pre-upgrade SQLite state, including committed WAL. */
export function initializeLocalSchema(db: DatabaseSync, path: string, upgrade: () => void): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const existing = tables.length > 0;
  const hasMigrations = tables.some((table) => table.name === 'migrations');
  const versions = hasMigrations
    ? db.prepare('SELECT version FROM migrations ORDER BY version').all().map((row) => Number(row.version))
    : [];
  if (versions.some((version) => version > desktopSchemaVersion))
    throw new Error('O banco foi criado por uma versão mais nova do LionPocket.');

  // Historical markers were also used for seeds; inspect additive columns as well.
  const requiredColumns: Record<string, string[]> = {
    categories: ['id'],
    payment_methods: ['id'],
    goals: ['id'],
    cards: ['due_day', 'closing_day'],
    transactions: ['purchase_date'],
    installment_purchases: ['starting_installment', 'purchase_date'],
    recurring_expenses: ['kind', 'start_month', 'card_id', 'charge_day', 'start_date', 'frequency', 'interval_count', 'interval_unit', 'anchor_to_actual', 'manual_months'],
    recurring_transaction_priorities: ['pinned_from_month'],
    transaction_priority_order: ['month'],
  };
  const complete = Array.from({ length: desktopSchemaVersion }, (_, index) => index + 1)
    .every((version) => versions.includes(version))
    && Object.entries(requiredColumns).every(([table, columns]) => {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      return columns.every((column) => actual.includes(column));
    });
  if (complete) return; // Do not replay historical data corrections on current databases.

  if (existing && path !== ':memory:') {
    const recoveryPath = `${path}.pre-migration-${randomUUID()}.sqlite`;
    try {
      // The constructor is synchronous; node:sqlite.backup is asynchronous.
      // VACUUM INTO is the synchronous consistent-snapshot alternative.
      db.prepare('VACUUM INTO ?').run(recoveryPath);
    } catch (cause) {
      throw new Error('Não foi possível proteger o banco antes da atualização.', { cause });
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    upgrade();
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0].integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('A atualização não pôde preservar a integridade do banco.');
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}
