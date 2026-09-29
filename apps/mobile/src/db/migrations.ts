import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';

const migrations: ReadonlyArray<ReadonlyArray<string>> = [
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
];

export async function migrate(db: NitroSQLiteConnection): Promise<void> {
  const { rows } = await db.executeAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = Number(rows._array[0]?.user_version ?? 0);
  if (currentVersion > migrations.length) {
    throw new Error('O banco foi criado por uma versão mais nova do LionPocket.');
  }

  for (let index = currentVersion; index < migrations.length; index += 1) {
    await db.transaction(async tx => {
      for (const statement of migrations[index]) {
        await tx.executeAsync(statement);
      }
      await tx.executeAsync(`PRAGMA user_version = ${index + 1}`);
    });
  }
}
