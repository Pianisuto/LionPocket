import {
  toCents,
  validateTransaction,
  normalizeSearchText,
  type CatalogInput,
  type ImportedTransaction,
  type SpreadsheetPlan,
  type BackupData,
  type BackupRow,
  type LocalBackup,
} from '@lionpocket/core';
import { MobileRepository } from './repository';
import { newId, type Connection } from './planningRepository';
import { backupTables, captureBackup } from './backupRepository';

export interface ImportPlan {
  catalogs: CatalogInput[];
  recurring: SpreadsheetPlan['recurring'];
  goals: SpreadsheetPlan['goals'];
  transactions: ImportedTransaction[];
}
export interface ImportCounts {
  transactions: number;
  recurring: number;
  goals: number;
  catalogs: number;
  skipped: number;
}
export function csvImportPlan(rows: ImportedTransaction[]): ImportPlan {
  return { catalogs: [], recurring: [], goals: [], transactions: rows };
}
/** All catalog creation and rows share the outer SQLite transaction. No queued self-waits. */
export async function applyImportPlan(db: Connection, plan: ImportPlan): Promise<ImportCounts> {
  return db.transaction(async (tx) => {
    const bound: Connection = {
      executeAsync: tx.executeAsync.bind(tx),
      transaction: async (action) => action(tx),
    };
    const repo = new MobileRepository(bound);
    const ids = new Map<string, string>();
    const result: ImportCounts = {
      transactions: 0,
      recurring: 0,
      goals: 0,
      catalogs: 0,
      skipped: 0,
    };
    const catalog = async (input: CatalogInput) => {
      const catalogs = await repo.catalogs();
      const collection =
        input.type === 'category'
          ? catalogs.categories.filter((c) => c.kind === input.kind)
          : input.type === 'card'
            ? catalogs.cards
            : catalogs.paymentMethods;
      let existing = collection.find(
        (c) => normalizeSearchText(c.name.trim()) === normalizeSearchText(input.name.trim()),
      );
      if (!existing) {
        await repo.createCatalog({ ...input, id: undefined });
        result.catalogs++;
        const updated = await repo.catalogs();
        existing = (
          input.type === 'category'
            ? updated.categories.filter((c) => c.kind === input.kind)
            : input.type === 'card'
              ? updated.cards
              : updated.paymentMethods
        ).find((c) => c.name === input.name.trim());
      }
      if (!existing) throw new Error('Não foi possível criar o cadastro.');
      return existing.id;
    };
    for (const input of plan.catalogs) ids.set(input.id ?? '', await catalog(input));
    const refs = <
      T extends {
        categoryId?: string | null;
        paymentMethodId?: string | null;
        cardId?: string | null;
      },
    >(
      input: T,
    ): T => ({
      ...input,
      categoryId: input.categoryId ? (ids.get(input.categoryId) ?? input.categoryId) : null,
      paymentMethodId: input.paymentMethodId
        ? (ids.get(input.paymentMethodId) ?? input.paymentMethodId)
        : null,
      cardId: input.cardId ? (ids.get(input.cardId) ?? input.cardId) : null,
    });
    const seenRecurring = new Set(
      (await repo.listRecurring()).map(
        (r) => `${r.kind}:${normalizeSearchText(r.description.trim())}`,
      ),
    );
    for (const input of plan.recurring) {
      const key = `${input.kind}:${normalizeSearchText(input.description.trim())}`;
      if (seenRecurring.has(key)) {
        result.skipped++;
        continue;
      }
      await repo.saveRecurring(refs(input));
      seenRecurring.add(key);
      result.recurring++;
    }
    const seenGoals = new Set((await repo.listGoals()).map((g) => g.name));
    for (const input of plan.goals) {
      if (seenGoals.has(input.name)) {
        result.skipped++;
        continue;
      }
      await repo.saveGoal(refs(input));
      seenGoals.add(input.name);
      result.goals++;
    }
    for (const row of plan.transactions) {
      const existing = await tx.executeAsync(
        `SELECT source_key FROM local_import_records WHERE source_key = ?
        UNION ALL SELECT source_id FROM transactions WHERE source_type = 'imported' AND source_id = ? LIMIT 1`,
        [row.sourceKey, row.sourceKey],
      );
      if (existing.rows._array.length) {
        result.skipped++;
        continue;
      }
      const input = refs(row.input);
      if (row.categoryName)
        input.categoryId = await catalog({
          type: 'category',
          kind: input.kind,
          name: row.categoryName,
        });
      if (row.paymentMethodName)
        input.paymentMethodId = await catalog({
          type: 'paymentMethod',
          name: row.paymentMethodName,
        });
      if (row.cardName)
        input.cardId = await catalog({ type: 'card', name: row.cardName, dueDay: 10 });
      validateTransaction(input, await repo.catalogs());
      await tx.executeAsync(
        `INSERT INTO transactions (id, kind, description, category_id, planned_amount_cents, actual_amount_cents, due_date, settled_date, status, payment_method_id, card_id, purchase_date, notes, source_type, source_id, installment_number, installment_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?)`,
        [
          await newId(tx),
          input.kind,
          input.description.trim(),
          input.categoryId ?? null,
          toCents(input.plannedAmount),
          toCents(input.actualAmount),
          input.dueDate,
          input.settledDate ?? null,
          input.status,
          input.paymentMethodId ?? null,
          input.cardId ?? null,
          input.purchaseDate ?? null,
          input.notes ?? '',
          row.sourceKey,
          row.installmentNumber ?? null,
          row.installmentTotal ?? null,
        ],
      );
      await tx.executeAsync("INSERT INTO local_import_records VALUES (?, datetime('now'))", [
        row.sourceKey,
      ]);
      result.transactions++;
    }
    return result;
  });
}
const identity = (table: string, row: BackupRow) =>
  table === 'transaction_priority_order'
    ? `${row.month}:${row.transaction_id}`
    : table === 'recurring_transaction_priorities'
      ? row.recurring_id
      : table === 'local_import_records'
        ? row.source_key
        : row.id;
/** JSON desktop imports add records and never overwrite an existing identity. */
export function mergeBackupData(
  current: BackupData,
  incoming: BackupData,
): { data: BackupData; added: number; skipped: number } {
  const data: BackupData = Object.fromEntries(
    backupTables.map((table) => [table, current[table].map((row) => ({ ...row }))]),
  );
  const categoryIds = new Map<string, string>(),
    paymentIds = new Map<string, string>(),
    cardIds = new Map<string, string>();
  let added = 0,
    skipped = 0;
  for (const table of backupTables)
    for (const original of incoming[table]) {
      const row = { ...original };
      if (row.category_id && categoryIds.has(String(row.category_id)))
        row.category_id = categoryIds.get(String(row.category_id)) as string;
      if (row.payment_method_id && paymentIds.has(String(row.payment_method_id)))
        row.payment_method_id = paymentIds.get(String(row.payment_method_id)) as string;
      if (row.card_id && cardIds.has(String(row.card_id)))
        row.card_id = cardIds.get(String(row.card_id)) as string;
      if (['categories', 'payment_methods', 'cards'].includes(table)) {
        const same = data[table].find(
          (r) =>
            normalizeSearchText(r.name) === normalizeSearchText(row.name) &&
            (table !== 'categories' || r.kind === row.kind),
        );
        if (same) {
          (table === 'categories' ? categoryIds : table === 'cards' ? cardIds : paymentIds).set(
            String(row.id),
            String(same.id),
          );
          skipped++;
          continue;
        }
      }
      const existing = data[table].find((r) => identity(table, r) === identity(table, row));
      if (existing) {
        if (Object.keys(row).some((key) => existing[key] !== row[key]))
          throw new Error(
            'O JSON contém registros que conflitam com IDs existentes. Nenhum dado foi substituído.',
          );
        skipped++;
        continue;
      }
      // Desktop priorities are global to that database. Keep existing mobile priorities;
      // imported priorities are assigned free positions without removing hidden items.
      if (table === 'recurring_transaction_priorities')
        row.position = Math.max(-1, ...data[table].map((r) => Number(r.position))) + 1;
      if (table === 'transaction_priority_order')
        row.position =
          Math.max(
            -1,
            ...data[table].filter((r) => r.month === row.month).map((r) => Number(r.position)),
          ) + 1;
      data[table].push(row);
      added++;
    }
  return { data, added, skipped };
}
export async function mergedDesktopBackup(db: Connection, backup: LocalBackup) {
  const current = await captureBackup(db);
  const merged = mergeBackupData(current.data, backup.data);
  return { ...merged, backup: { ...current, data: merged.data } };
}
