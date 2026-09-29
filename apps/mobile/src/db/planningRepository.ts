import {
  addDays,
  addMonths,
  calculateGoal,
  fixedRecurringDates,
  fromCents,
  monthRange,
  normalizeRecurring,
  planInstallmentUpdate,
  recurringEffectiveDate,
  recurringOccurrence,
  rollingRecurringDates,
  toCents,
  validateGoal,
  validateInstallment,
  validateMonth,
} from '@lionpocket/core';
import type {
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  RecurringExpense,
  RecurringExpenseInput,
  Transaction,
} from '@lionpocket/core';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';

type SqlRow<T> = { [K in keyof T]: T[K] };
export type Query = Pick<NitroSQLiteConnection, 'executeAsync'>;
export type Connection = Pick<NitroSQLiteConnection, 'executeAsync' | 'transaction'>;
export async function newId(db: Query): Promise<string> {
  const result = await db.executeAsync<{ id: string }>('SELECT lower(hex(randomblob(16))) AS id');
  const id = result.rows._array[0]?.id;
  if (!id) throw new Error('Não foi possível gerar o identificador.');
  return id;
}
// Transactions must use the native tx handle, never the queued connection inside a callback.
export class PlanningRepository {
  constructor(protected db: Connection) {}

  protected async readCatalogs(db: Query): Promise<Catalogs> {
    const categories = await db.executeAsync<SqlRow<Catalogs['categories'][number]>>(
      'SELECT * FROM categories ORDER BY name COLLATE NOCASE',
    );
    const methods = await db.executeAsync<SqlRow<Catalogs['paymentMethods'][number]>>(
      'SELECT * FROM payment_methods ORDER BY name COLLATE NOCASE',
    );
    const cards = await db.executeAsync<SqlRow<Catalogs['cards'][number]>>(
      'SELECT id, name, due_day AS dueDay, closing_day AS closingDay FROM cards ORDER BY name COLLATE NOCASE',
    );
    return {
      categories: categories.rows._array,
      paymentMethods: methods.rows._array,
      cards: cards.rows._array,
    };
  }

  private async recurring(db: Query): Promise<RecurringExpense[]> {
    const result = await db.executeAsync<
      Omit<RecurringExpense, 'active' | 'anchorToActual' | 'manualMonths'> & {
        active: number;
        anchorToActual: number;
        manualMonths: string;
        plannedCents: number;
      }
    >(`
      SELECT r.id, r.kind, r.active, r.description, r.start_month AS startMonth, r.start_date AS startDate,
        r.frequency, r.interval_count AS intervalCount, r.interval_unit AS intervalUnit,
        r.anchor_to_actual AS anchorToActual, r.manual_months AS manualMonths,
        r.category_id AS categoryId, c.name AS categoryName, r.payment_method_id AS paymentMethodId,
        pm.name AS paymentMethodName, r.card_id AS cardId, ca.name AS cardName,
        r.planned_amount_cents AS plannedCents, r.due_day AS dueDay, r.charge_day AS chargeDay, r.notes
      FROM recurring_expenses r LEFT JOIN categories c ON c.id = r.category_id
      LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id LEFT JOIN cards ca ON ca.id = r.card_id
      WHERE r.deleted_at IS NULL ORDER BY r.kind, r.active DESC, r.due_day, r.description COLLATE NOCASE`);
    return result.rows._array.map(
      ({ plannedCents, active, anchorToActual, manualMonths, ...row }) => ({
        ...row,
        active: Boolean(active),
        anchorToActual: Boolean(anchorToActual),
        manualMonths: manualMonths.split(',').filter(Boolean),
        plannedAmount: fromCents(plannedCents) ?? 0,
      }),
    );
  }
  async listRecurring(): Promise<RecurringExpense[]> {
    return this.recurring(this.db);
  }

  private async history(db: Query, source: string, id: string) {
    const result = await db.executeAsync<
      SqlRow<
        Pick<
          Transaction,
          | 'id'
          | 'kind'
          | 'description'
          | 'sourceId'
          | 'purchaseDate'
          | 'dueDate'
          | 'settledDate'
          | 'status'
          | 'installmentNumber'
        >
      > & {
        deletedAt: string | null;
        occurrenceDate: string | null;
        actualCents: number | null;
      }
    >(
      `
      SELECT id, kind, description, source_id AS sourceId, purchase_date AS purchaseDate, due_date AS dueDate,
        settled_date AS settledDate, status, installment_number AS installmentNumber,
        actual_amount_cents AS actualCents, deleted_at AS deletedAt, occurrence_date AS occurrenceDate
      FROM transactions WHERE source_type = ? AND source_id = ? ORDER BY due_date, id`,
      [source, id],
    );
    return result.rows._array;
  }

  private async insertGenerated(
    db: Query,
    item: RecurringExpenseInput | InstallmentPurchaseInput,
    sourceType: 'recurring' | 'installment',
    sourceId: string,
    occurrence: { dueDate: string; purchaseDate: string | null; cardId: string | null },
    occurrenceDate: string | null,
    installment: number | null = null,
  ) {
    await db.executeAsync(
      `INSERT INTO transactions (
      id, kind, description, category_id, planned_amount_cents, purchase_date, due_date, status,
      payment_method_id, card_id, notes, source_type, source_id, occurrence_date, installment_number, installment_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        await newId(db),
        'kind' in item ? item.kind : 'expense',
        item.description.trim(),
        item.categoryId ?? null,
        toCents('plannedAmount' in item ? item.plannedAmount : item.installmentAmount),
        occurrence.purchaseDate,
        occurrence.dueDate,
        item.paymentMethodId ?? null,
        occurrence.cardId,
        item.notes?.trim() ?? '',
        sourceType,
        sourceId,
        occurrenceDate,
        installment,
        'totalInstallments' in item ? item.totalInstallments : null,
      ],
    );
  }

  async generateMonth(month: string): Promise<void> {
    validateMonth(month);
    const { start, end } = monthRange(month);
    await this.db.transaction(async (tx) => {
      const catalogs = await this.readCatalogs(tx);
      for (const item of (await this.recurring(tx)).filter((r) => r.active)) {
        let history = await this.history(tx, 'recurring', item.id);
        const candidateStart = item.cardId ? addDays(start, -70) : start;
        const dates =
          item.frequency === 'custom' && item.anchorToActual
            ? rollingRecurringDates(item, history, candidateStart, end)
            : fixedRecurringDates(item, candidateStart, end);
        for (const scheduled of dates) {
          if (
            history.some(
              (t) => t.occurrenceDate === scheduled || (t.purchaseDate ?? t.dueDate) === scheduled,
            )
          )
            continue;
          const occurrence = recurringOccurrence(
            item,
            scheduled,
            catalogs.cards.find((c) => c.id === item.cardId),
          );
          if (
            item.frequency === 'monthly' &&
            history.some(
              (t) =>
                t.purchaseDate?.slice(0, 7) === scheduled.slice(0, 7) ||
                (!item.cardId &&
                  !t.purchaseDate &&
                  t.dueDate.slice(0, 7) === scheduled.slice(0, 7)) ||
                t.occurrenceDate?.slice(0, 7) === scheduled.slice(0, 7) ||
                t.dueDate === occurrence.dueDate,
            )
          )
            continue;
          if (occurrence.dueDate.slice(0, 7) !== month) continue;
          await this.insertGenerated(tx, item, 'recurring', item.id, occurrence, scheduled);
          history = await this.history(tx, 'recurring', item.id);
        }
      }
    });
  }

  async saveRecurring(input: RecurringExpenseInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const catalogs = await this.readCatalogs(tx);
      const item = normalizeRecurring(input, catalogs);
      const all = await this.recurring(tx);
      const original = all.find((r) => r.id === input.id);
      if (input.id && !original) throw new Error('Recorrência não encontrada.');
      if (
        all.some(
          (r) =>
            r.id !== input.id &&
            r.kind === item.kind &&
            r.description.trim().toLocaleLowerCase('pt-BR') ===
              item.description.toLocaleLowerCase('pt-BR'),
        )
      )
        throw new Error('Já existe uma recorrência com esse nome. Edite a existente.');
      const id = input.id ?? (await newId(tx));
      const values = [
        item.kind,
        item.active ? 1 : 0,
        item.description,
        item.startMonth,
        item.startDate,
        item.frequency,
        item.intervalCount,
        item.intervalUnit,
        item.anchorToActual ? 1 : 0,
        item.manualMonths.join(','),
        item.categoryId ?? null,
        item.paymentMethodId ?? null,
        item.cardId,
        toCents(item.plannedAmount),
        item.dueDay,
        item.chargeDay,
        item.notes?.trim() ?? '',
      ];
      if (original) {
        await tx.executeAsync(
          `UPDATE recurring_expenses SET kind = ?, active = ?, description = ?, start_month = ?,
          start_date = ?, frequency = ?, interval_count = ?, interval_unit = ?, anchor_to_actual = ?, manual_months = ?,
          category_id = ?, payment_method_id = ?, card_id = ?, planned_amount_cents = ?, due_day = ?, charge_day = ?, notes = ?,
          updated_at = datetime('now') WHERE id = ?`,
          [...values, id],
        );
        const scheduleChanged =
          original.frequency !== item.frequency ||
          (item.frequency !== 'monthly' &&
            (original.startDate !== item.startDate ||
              original.intervalCount !== item.intervalCount ||
              original.intervalUnit !== item.intervalUnit ||
              original.anchorToActual !== item.anchorToActual ||
              original.manualMonths.join(',') !== item.manualMonths.join(',')));
        const pending = (await this.history(tx, 'recurring', id)).filter(
          (t) =>
            t.status === 'planned' &&
            t.actualCents == null &&
            t.settledDate == null &&
            t.deletedAt == null,
        );
        if (scheduleChanged || item.frequency !== 'monthly') {
          await tx.executeAsync(
            `DELETE FROM transactions WHERE source_type = 'recurring' AND source_id = ?
            AND status = 'planned' AND actual_amount_cents IS NULL AND settled_date IS NULL AND deleted_at IS NULL`,
            [id],
          );
        } else {
          for (const t of pending)
            await tx.executeAsync(
              "UPDATE transactions SET due_date = 'pending-' || id WHERE id = ?",
              [t.id],
            );
          for (const t of pending) {
            const chargeMonth = (t.purchaseDate ?? t.dueDate).slice(0, 7);
            const scheduled = normalizeRecurring(
              { ...item, startMonth: chargeMonth },
              catalogs,
            ).startDate;
            const occurrence = recurringOccurrence(
              item,
              scheduled,
              catalogs.cards.find((c) => c.id === item.cardId),
            );
            const collision = await tx.executeAsync<{ id: string }>(
              `SELECT id FROM transactions WHERE source_type = 'recurring'
              AND source_id = ? AND due_date = ? AND id != ? AND deleted_at IS NULL LIMIT 1`,
              [id, occurrence.dueDate, t.id],
            );
            if (chargeMonth < item.startMonth || collision.rows._array.length) {
              await tx.executeAsync(
                "UPDATE transactions SET deleted_at = datetime('now') WHERE id = ?",
                [t.id],
              );
              // Keep valid dates on tombstones as well.
              await tx.executeAsync('UPDATE transactions SET due_date = ? WHERE id = ?', [
                occurrence.dueDate,
                t.id,
              ]);
            } else {
              await tx.executeAsync(
                `UPDATE transactions SET kind = ?, description = ?, category_id = ?, planned_amount_cents = ?,
                purchase_date = ?, due_date = ?, payment_method_id = ?, card_id = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
                [
                  item.kind,
                  item.description,
                  item.categoryId ?? null,
                  toCents(item.plannedAmount),
                  occurrence.purchaseDate,
                  occurrence.dueDate,
                  item.paymentMethodId ?? null,
                  occurrence.cardId,
                  item.notes?.trim() ?? '',
                  t.id,
                ],
              );
            }
          }
        }
      } else {
        await tx.executeAsync(
          `INSERT INTO recurring_expenses (kind, active, description, start_month, start_date, frequency,
          interval_count, interval_unit, anchor_to_actual, manual_months, category_id, payment_method_id, card_id,
          planned_amount_cents, due_day, charge_day, notes, id) VALUES (${values.map(() => '?').join(',')}, ?)`,
          [...values, id],
        );
      }
    });
  }

  protected async resetRolling(db: Query, transactionId: string): Promise<void> {
    const result = await db.executeAsync<SqlRow<Transaction> & { recurringCardId: string | null }>(
      `SELECT t.source_id AS sourceId,
      t.purchase_date AS purchaseDate, t.due_date AS dueDate, t.settled_date AS settledDate, t.status, r.card_id AS recurringCardId
      FROM transactions t JOIN recurring_expenses r ON r.id = t.source_id
      WHERE t.id = ? AND t.source_type = 'recurring' AND r.frequency = 'custom' AND r.anchor_to_actual = 1`,
      [transactionId],
    );
    const t = result.rows._array[0];
    if (!t) return;
    const effective = recurringEffectiveDate({ cardId: t.recurringCardId }, t);
    await db.executeAsync(
      `DELETE FROM transactions WHERE source_type = 'recurring' AND source_id = ? AND id != ?
      AND status = 'planned' AND actual_amount_cents IS NULL AND settled_date IS NULL AND deleted_at IS NULL
      AND COALESCE(purchase_date, due_date) > ?`,
      [t.sourceId, transactionId, effective],
    );
  }

  async removeRecurring(id: string): Promise<void> {
    const result = await this.db.executeAsync(
      "UPDATE recurring_expenses SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!result.rowsAffected) throw new Error('Recorrência não encontrada.');
  }

  async saveInstallment(input: InstallmentPurchaseInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      validateInstallment(input, await this.readCatalogs(tx));
      const id = input.id ?? (await newId(tx));
      const original = await tx.executeAsync<{ starting: number }>(
        'SELECT starting_installment AS starting FROM installment_purchases WHERE id = ? AND deleted_at IS NULL',
        [id],
      );
      if (input.id && !original.rows._array.length)
        throw new Error('Compra parcelada não encontrada.');
      const history = (await this.history(tx, 'installment', id)).filter((t) => !t.deletedAt);
      const plan = planInstallmentUpdate(
        input,
        original.rows._array[0]?.starting ?? input.currentInstallment,
        history.map((t) => ({ ...t, installmentNumber: Number(t.installmentNumber) })),
      );
      if (input.id) {
        await tx.executeAsync(
          `UPDATE transactions SET installment_number = installment_number + ?, updated_at = datetime('now')
          WHERE source_type = 'installment' AND source_id = ? AND deleted_at IS NULL`,
          [plan.shift, id],
        );
        await tx.executeAsync(
          `UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now')
          WHERE source_type = 'installment' AND source_id = ? AND status = 'planned' AND installment_number > ? AND deleted_at IS NULL`,
          [id, plan.total],
        );
        await tx.executeAsync(
          `UPDATE transactions SET due_date = 'editing-' || id
          WHERE source_type = 'installment' AND source_id = ? AND status = 'planned' AND deleted_at IS NULL`,
          [id],
        );
        await tx.executeAsync(
          `UPDATE transactions SET description = ?, category_id = ?, purchase_date = ?, payment_method_id = ?,
          card_id = ?, notes = ?, installment_total = ?, updated_at = datetime('now')
          WHERE source_type = 'installment' AND source_id = ? AND deleted_at IS NULL`,
          [
            input.description.trim(),
            input.categoryId ?? null,
            input.purchaseDate ?? null,
            input.paymentMethodId ?? null,
            input.cardId ?? null,
            input.notes?.trim() ?? '',
            plan.total,
            id,
          ],
        );
      }
      for (const entry of plan.entries) {
        if (entry.existing?.status === 'planned') {
          await tx.executeAsync(
            "UPDATE transactions SET planned_amount_cents = ?, due_date = ?, updated_at = datetime('now') WHERE id = ?",
            [toCents(input.installmentAmount), entry.dueDate, entry.existing.id],
          );
        } else if (!entry.existing) {
          // Creation uses current due date as anchor, just like desktop (editing uses first due).
          const dueDate = input.id
            ? entry.dueDate
            : addMonths(input.currentDueDate, entry.number - input.currentInstallment);
          await this.insertGenerated(
            tx,
            input,
            'installment',
            id,
            { dueDate, purchaseDate: input.purchaseDate ?? null, cardId: input.cardId ?? null },
            null,
            entry.number,
          );
        }
      }
      const stillPlanned = await tx.executeAsync<{ id: string }>(
        `SELECT id FROM transactions WHERE source_type = 'installment'
        AND source_id = ? AND status = 'planned' AND deleted_at IS NULL LIMIT 1`,
        [id],
      );
      const values = [
        input.description.trim(),
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        toCents(input.installmentAmount),
        plan.total,
        plan.starting,
        input.purchaseDate ?? null,
        plan.firstDueDate,
        stillPlanned.rows._array.length ? 'active' : 'completed',
        input.notes?.trim() ?? '',
      ];
      if (input.id)
        await tx.executeAsync(
          `UPDATE installment_purchases SET description = ?, category_id = ?, payment_method_id = ?, card_id = ?,
        installment_amount_cents = ?, total_installments = ?, starting_installment = ?, purchase_date = ?, first_due_date = ?, status = ?,
        notes = ?, updated_at = datetime('now') WHERE id = ?`,
          [...values, id],
        );
      else
        await tx.executeAsync(
          `INSERT INTO installment_purchases (description, category_id, payment_method_id, card_id,
        installment_amount_cents, total_installments, starting_installment, purchase_date, first_due_date, status, notes, id)
        VALUES (${values.map(() => '?').join(',')}, ?)`,
          [...values, id],
        );
    });
  }

  async listInstallments(
    month: string,
  ): Promise<Array<InstallmentPurchase & { paymentMethodId: string | null }>> {
    validateMonth(month);
    const { start, end } = monthRange(month);
    const result = await this.db.executeAsync<
      SqlRow<InstallmentPurchase> & { paymentMethodId: string | null; cents: number }
    >(
      `
      SELECT p.id, p.description, p.category_id AS categoryId, c.name AS categoryName,
        p.card_id AS cardId, ca.name AS cardName, p.payment_method_id AS paymentMethodId,
        p.installment_amount_cents AS cents, p.total_installments AS totalInstallments,
        p.starting_installment AS startingInstallment, p.purchase_date AS purchaseDate, p.first_due_date AS firstDueDate,
        p.status, p.notes, viewed.installment_number AS viewedInstallment, viewed.due_date AS viewedDueDate, viewed.status AS viewedStatus,
        (p.starting_installment - 1) + (SELECT COUNT(*) FROM transactions progress
          WHERE progress.source_type = 'installment' AND progress.source_id = p.id AND progress.status = 'paid'
            AND progress.deleted_at IS NULL AND progress.due_date < ?) AS paidInstallments
      FROM installment_purchases p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN cards ca ON ca.id = p.card_id
      JOIN transactions viewed ON viewed.source_type = 'installment' AND viewed.source_id = p.id
        AND viewed.deleted_at IS NULL AND viewed.due_date >= ? AND viewed.due_date < ?
      WHERE p.deleted_at IS NULL GROUP BY p.id ORDER BY viewed.due_date, p.description COLLATE NOCASE`,
      [end, start, end],
    );
    return result.rows._array.map(({ cents, ...row }) => ({
      ...row,
      installmentAmount: fromCents(cents) ?? 0,
      paidInstallments: Math.min(row.totalInstallments, row.paidInstallments),
    }));
  }

  async removeInstallment(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.executeAsync(
        "UPDATE installment_purchases SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
        [id],
      );
      if (!result.rowsAffected) throw new Error('Compra parcelada não encontrada.');
      await tx.executeAsync(
        `UPDATE transactions SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE source_type = 'installment' AND source_id = ? AND status = 'planned' AND deleted_at IS NULL`,
        [id],
      );
    });
  }
  async listGoals(): Promise<Goal[]> {
    const result = await this.db.executeAsync<
      SqlRow<Goal> & { targetCents: number; savedCents: number }
    >(`
      SELECT g.id, g.name, g.item_model AS itemModel, g.link, g.category_id AS categoryId, c.name AS categoryName,
        g.target_amount_cents AS targetCents, g.saved_amount_cents AS savedCents, g.priority, g.due_date AS dueDate, g.status, g.notes
      FROM goals g LEFT JOIN categories c ON c.id = g.category_id WHERE g.deleted_at IS NULL
      ORDER BY CASE g.status WHEN 'saving' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        CASE g.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, g.due_date IS NULL, g.due_date`);
    return result.rows._array.map(({ targetCents, savedCents, ...row }) => {
      const targetAmount = fromCents(targetCents) ?? 0,
        savedAmount = fromCents(savedCents) ?? 0;
      return {
        ...row,
        targetAmount,
        savedAmount,
        ...calculateGoal(targetAmount, savedAmount, row.dueDate),
      };
    });
  }
  async saveGoal(input: GoalInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      validateGoal(input, await this.readCatalogs(tx));
      const values = [
        input.name.trim(),
        input.itemModel?.trim() ?? '',
        input.link?.trim() ?? '',
        input.categoryId ?? null,
        toCents(input.targetAmount),
        toCents(input.savedAmount),
        input.priority,
        input.dueDate || null,
        input.status,
        input.notes?.trim() ?? '',
      ];
      if (input.id) {
        const result = await tx.executeAsync(
          `UPDATE goals SET name = ?, item_model = ?, link = ?, category_id = ?, target_amount_cents = ?,
          saved_amount_cents = ?, priority = ?, due_date = ?, status = ?, notes = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`,
          [...values, input.id],
        );
        if (!result.rowsAffected) throw new Error('Objetivo não encontrado.');
      } else
        await tx.executeAsync(
          `INSERT INTO goals (name, item_model, link, category_id, target_amount_cents, saved_amount_cents,
        priority, due_date, status, notes, id) VALUES (${values.map(() => '?').join(',')}, ?)`,
          [...values, await newId(tx)],
        );
    });
  }
  async removeGoal(id: string): Promise<void> {
    const result = await this.db.executeAsync(
      "UPDATE goals SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!result.rowsAffected) throw new Error('Objetivo não encontrado.');
  }
}
