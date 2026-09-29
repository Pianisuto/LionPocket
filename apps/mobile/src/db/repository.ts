import { fromCents, toCents, todayIso, validateMonth, validateTransaction } from '@lionpocket/core';
import type {
  CatalogInput,
  Catalogs,
  Transaction,
  TransactionFilters,
  TransactionInput,
} from '@lionpocket/core';

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
    isOverdue: row.kind === 'expense' && row.status === 'planned' && row.due_date < todayIso(),
    priorityPosition: null,
  };
}

export class MobileRepository extends PlanningRepository {
  async catalogs(): Promise<Catalogs> {
    return this.readCatalogs(this.db);
  }

  async createCatalog(input: CatalogInput): Promise<void> {
    const name = input.name.trim();
    if (!name) throw new Error('Informe um nome.');
    if (!['category', 'paymentMethod', 'card'].includes(input.type))
      throw new Error('Cadastro inválido.');
    if (input.type === 'category' && !['income', 'expense'].includes(input.kind ?? ''))
      throw new Error('Informe o tipo da categoria.');
    if (input.type === 'category' && input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color))
      throw new Error('Informe a cor como #RRGGBB.');
    if (input.type === 'card') {
      if (
        !Number.isInteger(input.dueDay) ||
        (input.dueDay ?? 0) < 1 ||
        (input.dueDay ?? 0) > 31 ||
        (input.closingDay != null &&
          (!Number.isInteger(input.closingDay) || input.closingDay < 1 || input.closingDay > 31))
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
        input.type === 'category' ? [name, input.kind ?? 'expense', id] : [name, id],
      );
      if (existing.rows._array.length) throw new Error('Já existe um cadastro com esse nome.');
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
          ? [name, input.kind ?? 'expense', input.color ?? '#8f8bff']
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
        const result = await tx.executeAsync(`UPDATE ${table} SET ${columns} WHERE id = ?`, [
          ...values,
          id,
        ]);
        if (!result.rowsAffected) throw new Error('Cadastro não encontrado.');
      } else
        await tx.executeAsync(
          `INSERT INTO ${table} VALUES (?, ${values.map(() => '?').join(',')})`,
          [id, ...values],
        );
    });
  }

  async removeCatalog(type: CatalogInput['type'], id: string): Promise<void> {
    if (!['category', 'paymentMethod', 'card'].includes(type))
      throw new Error('Cadastro inválido.');
    const table =
      type === 'category' ? 'categories' : type === 'card' ? 'cards' : 'payment_methods';
    const column =
      type === 'category' ? 'category_id' : type === 'card' ? 'card_id' : 'payment_method_id';
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
      const result = await tx.executeAsync(`DELETE FROM ${table} WHERE id = ?`, [id]);
      if (!result.rowsAffected) throw new Error('Cadastro não encontrado.');
    });
  }

  async list(filters: TransactionFilters): Promise<Transaction[]> {
    validateMonth(filters.month);
    await this.generateMonth(filters.month);
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
    const result = await this.db.executeAsync<Row>(
      `${select} WHERE ${conditions.join(' AND ')}
      ORDER BY CASE WHEN t.kind = 'expense' AND t.status = 'planned' AND t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date, t.created_at, t.id`,
      [...params, todayIso()],
    );
    return result.rows._array.map(fromRow);
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
