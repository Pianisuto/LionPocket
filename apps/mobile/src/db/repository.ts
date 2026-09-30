import {
  fromCents,
  toCents,
  todayIso,
  validateMonth,
  validateTransaction,
  filterTransactions,
  priorityOrderForMonth,
  applyPriorityChange,
  historySuggestions,
  summarizeMonth,
  categoryBreakdown,
  monthlyOverview,
  standardCategories,
  normalizeSearchText,
} from '@lionpocket/core';
import type {
  CatalogInput,
  Catalogs,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionPriorityInput,
} from '@lionpocket/core';

import type {
  NitroSQLiteConnection,
  Transaction as SQLiteTransaction,
} from 'react-native-nitro-sqlite';
import { PlanningRepository, newId } from './planningRepository';
type Row = {
  id: string;
  kind: Transaction['kind'];
  description: string;
  planned_amount_cents: number;
  actual_amount_cents: number | null;
  due_date: string;
  settled_date: string | null;
  status: Transaction['status'];
  notes: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  cardId: string | null;
  cardName: string | null;
  purchaseDate: string | null;
  source_type: Transaction['sourceType'];
  source_id: string | null;
  installment_number: number | null;
  installment_total: number | null;
};
const select = `SELECT t.*, c.name AS categoryName, c.color AS categoryColor,
  t.category_id AS categoryId, t.payment_method_id AS paymentMethodId,
  p.name AS paymentMethodName, t.card_id AS cardId, ca.name AS cardName,
  t.purchase_date AS purchaseDate FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN payment_methods p ON p.id = t.payment_method_id
  LEFT JOIN cards ca ON ca.id = t.card_id`;

function fromRow(row: Row): Transaction {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryColor: row.categoryColor,
    plannedAmount: fromCents(row.planned_amount_cents) ?? 0,
    actualAmount: fromCents(row.actual_amount_cents),
    dueDate: row.due_date,
    settledDate: row.settled_date,
    status: row.status,
    notes: row.notes,
    paymentMethodId: row.paymentMethodId,
    paymentMethodName: row.paymentMethodName,
    cardId: row.cardId,
    cardName: row.cardName,
    purchaseDate: row.purchaseDate,
    sourceType: row.source_type,
    sourceId: row.source_id,
    installmentNumber: row.installment_number,
    installmentTotal: row.installment_total,
    isOverdue:
      row.kind === 'expense' &&
      row.status === 'planned' &&
      row.due_date < todayIso(),
    priorityPosition: null,
  };
}

export class MobileRepository extends PlanningRepository {
  async monthlyOverview(month: string) {
    const items = await this.list({ month });
    return monthlyOverview(items, await this.listGoals(), month);
  }

  /** Explicit additive action; never repopulates a user's deletions on restore/open. */
  async completeStandardCategories(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = (await this.readCatalogs(tx)).categories;
      for (const [name, kind, color] of standardCategories) {
        if (
          existing.some(
            (c) =>
              c.kind === kind &&
              normalizeSearchText(c.name) === normalizeSearchText(name),
          )
        )
          continue;
        await tx.executeAsync(
          'INSERT INTO categories (id, name, kind, color) VALUES (?, ?, ?, ?)',
          [await newId(tx), name, kind, color],
        );
      }
    });
  }
  async catalogs(): Promise<Catalogs> {
    return this.readCatalogs(this.db);
  }

  async createCatalog(input: CatalogInput): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('Informe um nome.');
    if (!['category', 'paymentMethod', 'card'].includes(input.type))
      throw new Error('Cadastro inválido.');
    if (
      input.type === 'category' &&
      !['income', 'expense'].includes(input.kind ?? '')
    )
      throw new Error('Informe o tipo da categoria.');
    if (
      input.type === 'category' &&
      input.color &&
      !/^#[0-9a-fA-F]{6}$/.test(input.color)
    )
      throw new Error('Informe a cor como #RRGGBB.');
    if (input.type === 'card') {
      if (
        !Number.isInteger(input.dueDay) ||
        (input.dueDay ?? 0) < 1 ||
        (input.dueDay ?? 0) > 31 ||
        (input.closingDay != null &&
          (!Number.isInteger(input.closingDay) ||
            input.closingDay < 1 ||
            input.closingDay > 31))
      ) {
        throw new Error('Informe dias entre 1 e 31.');
      }
    }
    await this.db.transaction(async (tx) => {
      const id = input.id ?? (await newId(tx));
      const table =
        input.type === 'category'
          ? 'categories'
          : input.type === 'card'
            ? 'cards'
            : 'payment_methods';
      const existing = await tx.executeAsync<{ id: string }>(
        `SELECT id FROM ${table} WHERE lower(trim(name)) = lower(?)${input.type === 'category' ? ' AND kind = ?' : ''} AND id != ?`,
        input.type === 'category'
          ? [name, input.kind ?? 'expense', id]
          : [name, id],
      );
      if (existing.rows._array.length)
        throw new Error('Já existe um cadastro com esse nome.');
      if (input.type === 'category' && input.id) {
        // Changing kind on a used category would make existing references incompatible.
        const used = await tx.executeAsync<{ kind: string }>(
          `SELECT kind FROM categories WHERE id = ? AND kind != ?
        AND (EXISTS(SELECT 1 FROM transactions WHERE category_id = ?) OR EXISTS(SELECT 1 FROM recurring_expenses WHERE category_id = ?)
          OR EXISTS(SELECT 1 FROM installment_purchases WHERE category_id = ?))`,
          [id, input.kind ?? 'expense', id, id, id],
        );
        if (used.rows._array.length)
          throw new Error('Uma categoria em uso não pode mudar de tipo.');
      }
      const values =
        input.type === 'category'
          ? [name, input.kind ?? 'expense', input.color ?? '#9C8AA5']
          : input.type === 'card'
            ? [name, input.dueDay ?? 10, input.closingDay ?? null]
            : [name];
      if (input.id) {
        const columns =
          input.type === 'category'
            ? 'name = ?, kind = ?, color = ?'
            : input.type === 'card'
              ? 'name = ?, due_day = ?, closing_day = ?'
              : 'name = ?';
        const result = await tx.executeAsync(
          `UPDATE ${table} SET ${columns} WHERE id = ?`,
          [...values, id],
        );
        if (!result.rowsAffected) throw new Error('Cadastro não encontrado.');
      } else {
        const insertColumns =
          input.type === 'category'
            ? 'id, name, kind, color'
            : input.type === 'card'
              ? 'id, name, due_day, closing_day'
              : 'id, name';
        await tx.executeAsync(
          `INSERT INTO ${table} (${insertColumns}) VALUES (?, ${values.map(() => '?').join(',')})`,
          [id, ...values],
        );
      }
    });
  }

  async removeCatalog(type: CatalogInput['type'], id: string): Promise<void> {
    if (!['category', 'paymentMethod', 'card'].includes(type))
      throw new Error('Cadastro inválido.');
    const table =
      type === 'category'
        ? 'categories'
        : type === 'card'
          ? 'cards'
          : 'payment_methods';
    const column =
      type === 'category'
        ? 'category_id'
        : type === 'card'
          ? 'card_id'
          : 'payment_method_id';
    await this.db.transaction(async (tx) => {
      for (const entity of [
        'transactions',
        'recurring_expenses',
        'installment_purchases',
        ...(type === 'category' ? ['goals'] : []),
      ])
        await tx.executeAsync(
          `UPDATE ${entity} SET ${column} = NULL${type === 'card' && entity === 'recurring_expenses' ? ', charge_day = NULL' : ''} WHERE ${column} = ?`,
          [id],
        );
      const result = await tx.executeAsync(
        `DELETE FROM ${table} WHERE id = ?`,
        [id],
      );
      if (!result.rowsAffected) throw new Error('Cadastro não encontrado.');
    });
  }

  private async queryMonth(
    db: Pick<NitroSQLiteConnection, 'executeAsync'>,
    filters: TransactionFilters,
  ): Promise<Transaction[]> {
    const start = `${filters.month}-01`;
    // Strings ISO permitem selecionar a competência sem converter datas para UTC.
    const conditions = [
      `t.deleted_at IS NULL`,
      `(t.source_type != 'recurring' OR NOT EXISTS (SELECT 1 FROM recurring_expenses r
        WHERE r.id = t.source_id AND substr(t.due_date, 1, 7) < r.start_month))`,
      `(
      substr(t.due_date, 1, 7) = ? OR
      (t.kind = 'expense' AND t.status = 'planned' AND t.due_date < ? AND t.due_date < ?) OR
      (t.kind = 'expense' AND t.status = 'paid' AND substr(COALESCE(t.settled_date, t.due_date), 1, 7) = ?))`,
    ];
    const params = [filters.month, todayIso(), start, filters.month];
    if (filters.kind && filters.kind !== 'all') {
      conditions.push('t.kind = ?');
      params.push(filters.kind);
    }
    if (filters.status && filters.status !== 'all') {
      conditions.push('t.status = ?');
      params.push(filters.status);
    }
    const result = await db.executeAsync<Row>(
      `${select} WHERE ${conditions.join(' AND ')}
      ORDER BY CASE WHEN t.kind = 'expense' AND t.status = 'planned' AND t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date, t.created_at, t.id`,
      [...params, todayIso()],
    );
    return result.rows._array.map(fromRow);
  }

  private async priorities(
    db: Pick<NitroSQLiteConnection, 'executeAsync'>,
    month: string,
    items: Transaction[],
  ) {
    const recurring = await db.executeAsync<{
      recurringId: string;
      position: number;
      pinnedFromMonth: string;
    }>(
      'SELECT recurring_id AS recurringId, position, pinned_from_month AS pinnedFromMonth FROM recurring_transaction_priorities ORDER BY position, recurring_id',
    );
    const monthly = await db.executeAsync<{
      transactionId: string;
      position: number;
    }>(
      'SELECT transaction_id AS transactionId, position FROM transaction_priority_order WHERE month = ? ORDER BY position, transaction_id',
      [month],
    );
    const positions = new Map(
      priorityOrderForMonth(
        month,
        items,
        recurring.rows._array,
        monthly.rows._array,
      ).map((id, index) => [id, index]),
    );
    return items.map((t) => ({
      ...t,
      priorityPosition: positions.get(t.id) ?? null,
    }));
  }

  async list(filters: TransactionFilters): Promise<Transaction[]> {
    validateMonth(filters.month);
    await this.generateMonth(filters.month);
    return this.db.transaction(async (tx) => {
      const items = await this.queryMonth(tx, { month: filters.month });
      return filterTransactions(
        await this.priorities(tx, filters.month, items),
        filters,
      );
    });
  }

  async setPriority(input: TransactionPriorityInput): Promise<void> {
    validateMonth(input.month);
    await this.generateMonth(input.month);
    await this.db.transaction(async (tx: SQLiteTransaction) => {
      const items = await this.queryMonth(tx, { month: input.month });
      const item = items.find((t) => t.id === input.transactionId);
      if (!item) throw new Error('Lançamento não encontrado neste mês.');
      const timestamp = new Date().toISOString();
      if (item.sourceType === 'recurring' && item.sourceId) {
        if (input.pinned)
          await tx.executeAsync(
            `INSERT OR IGNORE INTO recurring_transaction_priorities
          (recurring_id, position, pinned_from_month, created_at, updated_at)
          SELECT ?, COALESCE(MAX(position), -1) + 1, ?, ?, ? FROM recurring_transaction_priorities`,
            [item.sourceId, input.month, timestamp, timestamp],
          );
        else {
          await tx.executeAsync(
            'DELETE FROM recurring_transaction_priorities WHERE recurring_id = ?',
            [item.sourceId],
          );
          await tx.executeAsync(
            `DELETE FROM transaction_priority_order WHERE transaction_id IN
            (SELECT id FROM transactions WHERE source_type = 'recurring' AND source_id = ?)`,
            [item.sourceId],
          );
        }
      }
      const changed = applyPriorityChange(
        await this.priorities(tx, input.month, items),
        item,
        input.pinned,
        input.beforeTransactionId ?? null,
      );
      const order = changed
        .filter((t) => t.priorityPosition !== null)
        .sort(
          (a, b) => Number(a.priorityPosition) - Number(b.priorityPosition),
        );
      await tx.executeAsync(
        'DELETE FROM transaction_priority_order WHERE month = ?',
        [input.month],
      );
      for (const [index, t] of order.entries())
        await tx.executeAsync(
          `INSERT INTO transaction_priority_order VALUES (?, ?, ?, ?, ?)`,
          [input.month, t.id, index, timestamp, timestamp],
        );
      const visible = [
        ...new Set(
          order
            .filter((t) => t.sourceType === 'recurring' && t.sourceId)
            .map((t) => t.sourceId as string),
        ),
      ];
      const global = (
        await tx.executeAsync<{ id: string }>(
          'SELECT recurring_id AS id FROM recurring_transaction_priorities ORDER BY position, recurring_id',
        )
      ).rows._array.map((r) => r.id);
      let index = 0;
      const merged = global.map((id) =>
        visible.includes(id) ? visible[index++] : id,
      );
      await tx.executeAsync(
        'UPDATE recurring_transaction_priorities SET position = position + 1000000000',
      );
      for (const [position, id] of merged.entries())
        await tx.executeAsync(
          'UPDATE recurring_transaction_priorities SET position = ?, updated_at = ? WHERE recurring_id = ?',
          [position, timestamp, id],
        );
    });
  }

  async exportTransactions(): Promise<Transaction[]> {
    const result = await this.db
      .executeAsync<Row>(`${select} WHERE t.deleted_at IS NULL AND
      (t.source_type != 'recurring' OR NOT EXISTS (SELECT 1 FROM recurring_expenses r WHERE r.id = t.source_id AND substr(t.due_date,1,7) < r.start_month))`);
    return result.rows._array.map(fromRow);
  }

  async suggest(kind: Transaction['kind'], term: string) {
    const result = await this.db
      .executeAsync<Row>(`${select} WHERE t.deleted_at IS NULL AND
      (t.source_type != 'recurring' OR NOT EXISTS (SELECT 1 FROM recurring_expenses r WHERE r.id = t.source_id AND substr(t.due_date,1,7) < r.start_month))`);
    return historySuggestions(result.rows._array.map(fromRow), kind, term);
  }

  async annual(year: string) {
    validateMonth(`${year}-01`);
    const months = [];
    for (let index = 1; index <= 12; index++) {
      const month = `${year}-${String(index).padStart(2, '0')}`;
      const items = await this.list({ month });
      months.push({
        summary: summarizeMonth(items, month),
        categories: categoryBreakdown(items, month),
      });
    }
    return months;
  }

  async save(input: TransactionInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      validateTransaction(input, await this.readCatalogs(tx));
      const values = [
        input.kind,
        input.description.trim(),
        toCents(input.plannedAmount),
        toCents(input.actualAmount),
        input.dueDate,
        input.settledDate ?? null,
        input.status,
        input.notes?.trim() ?? '',
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        input.purchaseDate ?? null,
      ];
      if (input.id) {
        const result = await tx.executeAsync(
          `UPDATE transactions SET kind = ?, description = ?,
        planned_amount_cents = ?, actual_amount_cents = ?, due_date = ?, settled_date = ?, status = ?,
        notes = ?, category_id = ?, payment_method_id = ?, card_id = ?, purchase_date = ?, updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
          [...values, input.id],
        );
        if (!result.rowsAffected) throw new Error('Lançamento não encontrado.');
      } else {
        await tx.executeAsync(
          `INSERT INTO transactions (kind, description, planned_amount_cents,
        actual_amount_cents, due_date, settled_date, status, notes, category_id, payment_method_id,
        card_id, purchase_date, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, await newId(tx)],
        );
      }
      if (input.id) await this.resetRolling(tx, input.id);
    });
  }

  async remove(id: string): Promise<void> {
    const result = await this.db.executeAsync(
      `UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    if (!result.rowsAffected) throw new Error('Lançamento não encontrado.');
  }

  async settle(id: string): Promise<void> {
    if (!(await this.settleMany([id])))
      throw new Error('O lançamento não está mais pendente. Atualize a lista.');
  }

  async settleMany(ids: string[]): Promise<number> {
    let count = 0;
    await this.db.transaction(async (tx) => {
      for (const id of new Set(ids)) {
        const result = await tx.executeAsync(
          `UPDATE transactions SET
          status = CASE WHEN kind = 'income' THEN 'received' ELSE 'paid' END,
          actual_amount_cents = COALESCE(actual_amount_cents, planned_amount_cents),
          settled_date = COALESCE(settled_date, ?), updated_at = datetime('now')
          WHERE id = ? AND status = 'planned' AND deleted_at IS NULL`,
          [todayIso(), id],
        );
        count += result.rowsAffected;
        if (result.rowsAffected) await this.resetRolling(tx, id);
      }
    });
    return count;
  }
}
