import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  CatalogInput,
  Catalogs,
  Category,
  CreditCard,
  Goal,
  GoalInput,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  MonthSummary,
  Overview,
  RecurringExpense,
  RecurringExpenseInput,
  SimpleCatalogItem,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionStatus,
} from '../shared/types';
import {
  addMonths,
  calculateGoal,
  currentMonthIso,
  dateForMonthDay,
  fromCents,
  monthRange,
  settlementDateFor,
  toCents,
  todayIso,
} from '../shared/finance';

type Row = Record<string, string | number | null>;

const now = () => new Date().toISOString();

const normalizeSearchText = (value: unknown) => String(value ?? '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLocaleLowerCase('pt-BR');

/** Cinza-ameixa: a cor de quem ainda não escolheu uma cor. */
export const NEUTRAL_COLOR = '#9C8AA5';

const seedCategories = [
  ['Moradia', 'expense', '#F2557F'],
  ['Contas da casa', 'expense', '#FF9142'],
  ['Alimentação', 'expense', '#FFC247'],
  ['Transporte', 'expense', '#4CC9F0'],
  ['Moto', 'expense', '#8B5CF6'],
  ['Saúde', 'expense', '#FF6B9A'],
  ['Assinaturas', 'expense', '#C77DFF'],
  ['Lazer', 'expense', '#FF7D54'],
  ['Compras', 'expense', '#E8467C'],
  ['Educação', 'expense', '#2DD4BF'],
  ['Pets/Animais', 'expense', '#F59E6B'],
  ['Casa', 'expense', '#7C9CF5'],
  ['Ferramentas/Projetos', 'expense', '#6366F1'],
  ['Impostos/Taxas', 'expense', '#EF4444'],
  ['Presentes/Apoio', 'expense', '#D946EF'],
  ['Outros', 'expense', NEUTRAL_COLOR],
  ['Salário CLT', 'income', '#34D399'],
  ['Freelance/Programa', 'income', '#22D3EE'],
  ['PIX/Apoio familiar', 'income', '#4ADE80'],
  ['Reembolso', 'income', '#60A5FA'],
  ['Venda', 'income', '#A78BFA'],
  ['Outros', 'income', NEUTRAL_COLOR],
] as const;

/**
 * Paleta antiga (tema verde) → paleta nova. Bancos já existentes recebem as
 * cores novas, mas só onde a cor ainda era a padrão: qualquer cor diferente
 * disso foi escolhida por alguém e fica como está.
 */
const legacyCategoryColors: Record<string, string> = {
  '#7C8CF8': '#F2557F',
  '#F0A45D': '#FF9142',
  '#57B894': '#FFC247',
  '#5D9CEC': '#4CC9F0',
  '#8D77D9': '#8B5CF6',
  '#E77D8F': '#FF6B9A',
  '#BA7AC5': '#C77DFF',
  '#ED8F5A': '#FF7D54',
  '#D6A64C': '#E8467C',
  '#4CA6A8': '#2DD4BF',
  '#AF8B63': '#F59E6B',
  '#657D6B': '#7C9CF5',
  '#6378B8': '#6366F1',
  '#C06D68': '#EF4444',
  '#D27A9C': '#D946EF',
  '#3B9970': '#34D399',
  '#48A486': '#22D3EE',
  '#5AA6A0': '#4ADE80',
  '#61A5D6': '#60A5FA',
  '#7D9BC8': '#A78BFA',
  '#86909C': NEUTRAL_COLOR,
};

const seedPaymentMethods = [
  'Cartão de crédito',
  'PIX',
  'Débito',
  'Dinheiro',
  'Boleto',
  'Transferência',
];

export class LionPocketDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.function('search_key', { deterministic: true }, normalizeSearchText);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.migrate();
    this.seed();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        color TEXT NOT NULL DEFAULT '#9C8AA5',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(name, kind)
      );

      CREATE TABLE IF NOT EXISTS payment_methods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        due_day INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'expense' CHECK(kind IN ('income', 'expense')),
        active INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        start_month TEXT NOT NULL,
        category_id TEXT REFERENCES categories(id),
        payment_method_id TEXT REFERENCES payment_methods(id),
        planned_cents INTEGER NOT NULL DEFAULT 0,
        due_day INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS installment_purchases (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        category_id TEXT REFERENCES categories(id),
        payment_method_id TEXT REFERENCES payment_methods(id),
        card_id TEXT REFERENCES cards(id),
        installment_cents INTEGER NOT NULL,
        total_installments INTEGER NOT NULL,
        starting_installment INTEGER NOT NULL DEFAULT 1,
        first_due_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        description TEXT NOT NULL,
        category_id TEXT REFERENCES categories(id),
        planned_cents INTEGER NOT NULL DEFAULT 0,
        actual_cents INTEGER,
        due_date TEXT NOT NULL,
        settled_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        payment_method_id TEXT REFERENCES payment_methods(id),
        card_id TEXT REFERENCES cards(id),
        notes TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        installment_number INTEGER,
        installment_total INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_unique
        ON transactions(source_type, source_id, due_date)
        WHERE source_id IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS transactions_due_date ON transactions(due_date);
      CREATE INDEX IF NOT EXISTS transactions_status ON transactions(status);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_model TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        category_id TEXT REFERENCES categories(id),
        target_cents INTEGER NOT NULL DEFAULT 0,
        saved_cents INTEGER NOT NULL DEFAULT 0,
        priority TEXT NOT NULL DEFAULT 'medium',
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (1, datetime('now'));
    `);

    // Bancos criados antes de os cartões terem vencimento continuam válidos.
    const cardColumns = this.db.prepare('PRAGMA table_info(cards)').all() as unknown as Row[];
    if (!cardColumns.some((column) => column.name === 'due_day')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN due_day INTEGER NOT NULL DEFAULT 10');
    }
    const installmentColumns = this.db
      .prepare('PRAGMA table_info(installment_purchases)')
      .all() as unknown as Row[];
    if (!installmentColumns.some((column) => column.name === 'starting_installment')) {
      this.db.exec(
        'ALTER TABLE installment_purchases ADD COLUMN starting_installment INTEGER NOT NULL DEFAULT 1',
      );
    }
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (2, datetime('now'))");
    const recurringColumns = this.db
      .prepare('PRAGMA table_info(recurring_expenses)')
      .all() as unknown as Row[];
    if (!recurringColumns.some((column) => column.name === 'kind')) {
      this.db.exec(
        "ALTER TABLE recurring_expenses ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense' CHECK(kind IN ('income', 'expense'))",
      );
    }
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (3, datetime('now'))");
    if (!recurringColumns.some((column) => column.name === 'start_month')) {
      this.db.exec('ALTER TABLE recurring_expenses ADD COLUMN start_month TEXT');
    }
    this.db.prepare(`
      UPDATE recurring_expenses
      SET start_month = substr(created_at, 1, 7)
      WHERE start_month IS NULL OR start_month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    `).run();
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (4, datetime('now'))");
  }

  private seed() {
    const catalogSeeded = this.db
      .prepare('SELECT 1 FROM migrations WHERE version = 5')
      .get();
    if (catalogSeeded) return;

    const categoryStatement = this.db.prepare(`
      INSERT OR IGNORE INTO categories(id, name, kind, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const timestamp = now();
    for (const [name, kind, color] of seedCategories) {
      categoryStatement.run(randomUUID(), name, kind, color, timestamp, timestamp);
    }

    const recolor = this.db.prepare(
      'UPDATE categories SET color = ?, updated_at = ? WHERE color = ?',
    );
    for (const [legacy, replacement] of Object.entries(legacyCategoryColors)) {
      recolor.run(replacement, timestamp, legacy);
    }

    const methodStatement = this.db.prepare(`
      INSERT OR IGNORE INTO payment_methods(id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const name of seedPaymentMethods) {
      methodStatement.run(randomUUID(), name, timestamp, timestamp);
    }

    // As listas iniciais entram uma única vez. Assim, uma categoria apagada
    // não volta na próxima abertura e cartões ficam sempre sob controle do usuário.
    this.db.prepare('INSERT INTO migrations(version, applied_at) VALUES (5, ?)').run(timestamp);
  }

  getCatalogs(): Catalogs {
    const categories = this.db
      .prepare('SELECT id, name, kind, color FROM categories ORDER BY kind, name COLLATE NOCASE')
      .all() as unknown as Category[];
    const paymentMethods = this.db
      .prepare('SELECT id, name FROM payment_methods ORDER BY name COLLATE NOCASE')
      .all() as unknown as SimpleCatalogItem[];
    const cards = this.db
      .prepare('SELECT id, name, due_day AS dueDay FROM cards ORDER BY name COLLATE NOCASE')
      .all() as unknown as CreditCard[];
    return { categories, paymentMethods, cards };
  }

  createCatalogItem(input: CatalogInput) {
    const timestamp = now();
    if (input.type === 'category') {
      this.db.prepare(`
        INSERT OR IGNORE INTO categories(id, name, kind, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        input.name.trim(),
        input.kind ?? 'expense',
        input.color ?? NEUTRAL_COLOR,
        timestamp,
        timestamp,
      );
      return;
    }
    if (input.type === 'card') {
      const dueDay = Math.min(31, Math.max(1, Math.round(input.dueDay ?? 10)));
      if (input.id) {
        this.db.prepare(`
          UPDATE cards SET name = ?, due_day = ?, updated_at = ? WHERE id = ?
        `).run(input.name.trim(), dueDay, timestamp, input.id);
      } else {
        this.db.prepare(`
          INSERT OR IGNORE INTO cards(id, name, due_day, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), input.name.trim(), dueDay, timestamp, timestamp);
      }
      return;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO payment_methods(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(randomUUID(), input.name.trim(), timestamp, timestamp);
  }

  deleteCatalogItem(type: 'category' | 'card', id: string) {
    this.db.exec('BEGIN');
    try {
      if (type === 'category') {
        this.db.prepare('UPDATE recurring_expenses SET category_id = NULL WHERE category_id = ?').run(id);
        this.db.prepare('UPDATE installment_purchases SET category_id = NULL WHERE category_id = ?').run(id);
        this.db.prepare('UPDATE transactions SET category_id = NULL WHERE category_id = ?').run(id);
        this.db.prepare('UPDATE goals SET category_id = NULL WHERE category_id = ?').run(id);
        this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      } else {
        this.db.prepare('UPDATE installment_purchases SET card_id = NULL WHERE card_id = ?').run(id);
        this.db.prepare('UPDATE transactions SET card_id = NULL WHERE card_id = ?').run(id);
        this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findOrCreateCategory(name: string, kind: 'income' | 'expense', color = NEUTRAL_COLOR) {
    const cleaned = name.trim();
    if (!cleaned) return null;
    const existing = this.db
      .prepare('SELECT id FROM categories WHERE name = ? AND kind = ?')
      .get(cleaned, kind) as Row | undefined;
    if (existing) return String(existing.id);
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO categories(id, name, kind, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, cleaned, kind, color, timestamp, timestamp);
    return id;
  }

  findOrCreatePaymentMethod(name: string) {
    const cleaned = name.trim();
    if (!cleaned) return null;
    const existing = this.db.prepare('SELECT id FROM payment_methods WHERE name = ?').get(cleaned) as
      | Row
      | undefined;
    if (existing) return String(existing.id);
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO payment_methods(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(id, cleaned, timestamp, timestamp);
    return id;
  }

  findOrCreateCard(name: string) {
    const cleaned = name.trim();
    if (!cleaned) return null;
    const existing = this.db.prepare('SELECT id FROM cards WHERE name = ?').get(cleaned) as
      | Row
      | undefined;
    if (existing) return String(existing.id);
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO cards(id, name, due_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      cleaned,
      10,
      timestamp,
      timestamp,
    );
    return id;
  }

  private transactionFromRow(row: Row): Transaction {
    return {
      id: String(row.id),
      kind: row.kind as Transaction['kind'],
      description: String(row.description),
      categoryId: row.categoryId ? String(row.categoryId) : null,
      categoryName: row.categoryName ? String(row.categoryName) : null,
      categoryColor: row.categoryColor ? String(row.categoryColor) : null,
      plannedAmount: fromCents(Number(row.plannedCents)) ?? 0,
      actualAmount: fromCents(row.actualCents === null ? null : Number(row.actualCents)),
      dueDate: String(row.dueDate),
      settledDate: row.settledDate ? String(row.settledDate) : null,
      status: row.status as Transaction['status'],
      paymentMethodId: row.paymentMethodId ? String(row.paymentMethodId) : null,
      paymentMethodName: row.paymentMethodName ? String(row.paymentMethodName) : null,
      cardId: row.cardId ? String(row.cardId) : null,
      cardName: row.cardName ? String(row.cardName) : null,
      notes: String(row.notes ?? ''),
      sourceType: row.sourceType as Transaction['sourceType'],
      sourceId: row.sourceId ? String(row.sourceId) : null,
      installmentNumber: row.installmentNumber === null ? null : Number(row.installmentNumber),
      installmentTotal: row.installmentTotal === null ? null : Number(row.installmentTotal),
    };
  }

  private transactionSelect() {
    return `
      SELECT t.id, t.kind, t.description,
        t.category_id AS categoryId, c.name AS categoryName, c.color AS categoryColor,
        t.planned_cents AS plannedCents, t.actual_cents AS actualCents,
        t.due_date AS dueDate, t.settled_date AS settledDate, t.status,
        t.payment_method_id AS paymentMethodId, pm.name AS paymentMethodName,
        t.card_id AS cardId, ca.name AS cardName, t.notes,
        t.source_type AS sourceType, t.source_id AS sourceId,
        t.installment_number AS installmentNumber, t.installment_total AS installmentTotal
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
      LEFT JOIN cards ca ON ca.id = t.card_id
    `;
  }

  /**
   * Versões antigas podiam materializar uma recorrência antes do mês em que
   * ela foi criada. Esses registros continuam preservados no banco, mas não
   * fazem parte do período válido da recorrência e não entram nas consultas.
   */
  private recurringPeriodCondition(alias = 't') {
    return `(
      ${alias}.source_type != 'recurring' OR ${alias}.source_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM recurring_expenses recurring_scope
        WHERE recurring_scope.id = ${alias}.source_id
          AND substr(${alias}.due_date, 1, 7) < COALESCE(
            recurring_scope.start_month,
            substr(recurring_scope.created_at, 1, 7)
          )
      )
    )`;
  }

  ensureRecurringForMonth(month: string) {
    const recurring = this.db.prepare(`
      SELECT * FROM recurring_expenses
      WHERE active = 1 AND deleted_at IS NULL AND COALESCE(start_month, substr(created_at, 1, 7)) <= ?
    `).all(month) as unknown as Row[];
    const { start, end } = monthRange(month);
    const existing = this.db.prepare(`
      SELECT id FROM transactions
      WHERE source_type = 'recurring' AND source_id = ? AND due_date >= ? AND due_date < ?
        AND deleted_at IS NULL
      LIMIT 1
    `);
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO transactions(
        id, kind, description, category_id, planned_cents, due_date, status,
        payment_method_id, notes, source_type, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, 'recurring', ?, ?, ?)
    `);
    const timestamp = now();
    for (const item of recurring) {
      if (existing.get(item.id, start, end)) continue;
      statement.run(
        randomUUID(),
        item.kind,
        item.description,
        item.category_id,
        item.planned_cents,
        dateForMonthDay(month, Number(item.due_day)),
        item.payment_method_id,
        item.notes,
        item.id,
        timestamp,
        timestamp,
      );
    }
  }

  listTransactions(filters: TransactionFilters): Transaction[] {
    this.ensureRecurringForMonth(filters.month);
    const { start, end } = monthRange(filters.month);
    const conditions = [
      't.deleted_at IS NULL',
      this.recurringPeriodCondition(),
      't.due_date >= ?',
      't.due_date < ?',
    ];
    const parameters: Array<string> = [start, end];
    if (filters.kind && filters.kind !== 'all') {
      conditions.push('t.kind = ?');
      parameters.push(filters.kind);
    }
    if (filters.status && filters.status !== 'all') {
      conditions.push('t.status = ?');
      parameters.push(filters.status);
    }
    if (filters.search?.trim()) {
      conditions.push(`search_key(
        COALESCE(t.description, '') || ' ' || COALESCE(c.name, '') || ' ' ||
        COALESCE(pm.name, '') || ' ' || COALESCE(ca.name, '') || ' ' || COALESCE(t.notes, '')
      ) LIKE ? ESCAPE '\\'`);
      const cleaned = normalizeSearchText(filters.search.trim()).replace(/[\\%_]/g, '\\$&');
      parameters.push(`%${cleaned}%`);
    }
    const rows = this.db
      .prepare(`${this.transactionSelect()} WHERE ${conditions.join(' AND ')} ORDER BY t.due_date, t.created_at`)
      .all(...parameters) as unknown as Row[];
    return rows.map((row) => this.transactionFromRow(row));
  }

  saveTransaction(input: TransactionInput): Transaction {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const actualCents = toCents(input.actualAmount);
    if (input.id) {
      this.db.prepare(`
        UPDATE transactions SET kind = ?, description = ?, category_id = ?, planned_cents = ?,
          actual_cents = ?, due_date = ?, settled_date = ?, status = ?, payment_method_id = ?,
          card_id = ?, notes = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        input.kind,
        input.description.trim(),
        input.categoryId ?? null,
        toCents(input.plannedAmount) ?? 0,
        actualCents,
        input.dueDate,
        input.settledDate ?? null,
        input.status,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        input.notes?.trim() ?? '',
        timestamp,
        id,
      );
    } else {
      this.db.prepare(`
        INSERT INTO transactions(
          id, kind, description, category_id, planned_cents, actual_cents, due_date,
          settled_date, status, payment_method_id, card_id, notes, source_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
      `).run(
        id,
        input.kind,
        input.description.trim(),
        input.categoryId ?? null,
        toCents(input.plannedAmount) ?? 0,
        actualCents,
        input.dueDate,
        input.settledDate ?? null,
        input.status,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        input.notes?.trim() ?? '',
        timestamp,
        timestamp,
      );
    }
    return this.getTransaction(id);
  }

  insertImportedTransaction(
    input: TransactionInput,
    sourceId: string,
    installmentNumber: number | null = null,
    installmentTotal: number | null = null,
  ) {
    const timestamp = now();
    this.db.prepare(`
      INSERT OR IGNORE INTO transactions(
        id, kind, description, category_id, planned_cents, actual_cents, due_date,
        settled_date, status, payment_method_id, card_id, notes, source_type, source_id,
        installment_number, installment_total, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.kind,
      input.description.trim(),
      input.categoryId ?? null,
      toCents(input.plannedAmount) ?? 0,
      toCents(input.actualAmount),
      input.dueDate,
      input.settledDate ?? null,
      input.status,
      input.paymentMethodId ?? null,
      input.cardId ?? null,
      input.notes?.trim() ?? '',
      sourceId,
      installmentNumber,
      installmentTotal,
      timestamp,
      timestamp,
    );
  }

  private getTransaction(id: string): Transaction {
    const row = this.db
      .prepare(`${this.transactionSelect()} WHERE t.id = ? AND t.deleted_at IS NULL`)
      .get(id) as Row | undefined;
    if (!row) throw new Error('Lançamento não encontrado.');
    return this.transactionFromRow(row);
  }

  deleteTransaction(id: string) {
    this.db.prepare('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
      now(),
      now(),
      id,
    );
  }

  settleTransaction(id: string) {
    const transaction = this.getTransaction(id);
    const status = transaction.kind === 'income' ? 'received' : 'paid';
    this.db.prepare(`
      UPDATE transactions SET status = ?, actual_cents = COALESCE(actual_cents, planned_cents),
        settled_date = COALESCE(settled_date, ?), updated_at = ? WHERE id = ?
    `).run(status, settlementDateFor(transaction.dueDate), now(), id);
  }

  /**
   * Quita uma lista inteira de uma vez — o fecho de um mês antigo em um clique.
   * Cada lançamento vira "pago" ou "recebido" conforme o tipo, assume o valor
   * planejado como valor real e é datado no próprio vencimento.
   */
  settleTransactions(ids: string[]): number {
    if (!ids.length) return 0;
    const timestamp = now();
    const today = todayIso();
    const statement = this.db.prepare(`
      UPDATE transactions
      SET status = CASE kind WHEN 'income' THEN 'received' ELSE 'paid' END,
        actual_cents = COALESCE(actual_cents, planned_cents),
        settled_date = COALESCE(settled_date, MIN(due_date, ?)),
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND status = 'planned'
    `);
    let settled = 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        settled += Number(statement.run(today, timestamp, id).changes);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return settled;
  }

  /**
   * Lançamentos parecidos já registrados antes. Quem preenche vários meses
   * digita as mesmas contas repetidas vezes; devolver categoria, forma de
   * pagamento e último valor evita reescrever tudo de novo.
   */
  suggestTransactions(kind: 'income' | 'expense', term: string, limit = 6) {
    const cleaned = term.trim();
    if (cleaned.length < 2) return [];
    const pattern = `%${cleaned.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = this.db.prepare(`
      SELECT t.description, t.category_id AS categoryId, c.name AS categoryName,
        t.payment_method_id AS paymentMethodId, t.card_id AS cardId,
        COALESCE(t.actual_cents, t.planned_cents) AS amountCents,
        MAX(t.due_date) AS lastDueDate, COUNT(*) AS uses
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.kind = ? AND t.status != 'cancelled'
        AND ${this.recurringPeriodCondition()}
        AND t.description LIKE ? ESCAPE '\\'
      GROUP BY LOWER(t.description)
      ORDER BY uses DESC, lastDueDate DESC
      LIMIT ?
    `).all(kind, pattern, limit) as unknown as Row[];
    return rows.map((row) => ({
      description: String(row.description),
      categoryId: row.categoryId ? String(row.categoryId) : null,
      categoryName: row.categoryName ? String(row.categoryName) : null,
      paymentMethodId: row.paymentMethodId ? String(row.paymentMethodId) : null,
      cardId: row.cardId ? String(row.cardId) : null,
      amount: fromCents(Number(row.amountCents)) ?? 0,
      uses: Number(row.uses),
    }));
  }

  listRecurringExpenses(): RecurringExpense[] {
    const rows = this.db.prepare(`
      SELECT r.id, r.kind, r.active, r.description, r.category_id AS categoryId,
        c.name AS categoryName, r.payment_method_id AS paymentMethodId,
        pm.name AS paymentMethodName, r.planned_cents AS plannedCents,
        r.due_day AS dueDay, COALESCE(r.start_month, substr(r.created_at, 1, 7)) AS startMonth,
        r.notes
      FROM recurring_expenses r
      LEFT JOIN categories c ON c.id = r.category_id
      LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
      WHERE r.deleted_at IS NULL
      ORDER BY CASE r.kind WHEN 'income' THEN 0 ELSE 1 END,
        r.active DESC, r.due_day, r.description COLLATE NOCASE
    `).all() as unknown as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as RecurringExpense['kind'],
      active: Boolean(row.active),
      description: String(row.description),
      startMonth: String(row.startMonth),
      categoryId: row.categoryId ? String(row.categoryId) : null,
      categoryName: row.categoryName ? String(row.categoryName) : null,
      paymentMethodId: row.paymentMethodId ? String(row.paymentMethodId) : null,
      paymentMethodName: row.paymentMethodName ? String(row.paymentMethodName) : null,
      plannedAmount: fromCents(Number(row.plannedCents)) ?? 0,
      dueDay: Number(row.dueDay),
      notes: String(row.notes ?? ''),
    }));
  }

  saveRecurringExpense(input: RecurringExpenseInput): RecurringExpense {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const plannedCents = toCents(input.plannedAmount) ?? 0;
    const dueDay = Math.min(31, Math.max(1, input.dueDay));
    const kind = input.kind === 'income' ? 'income' : 'expense';
    const description = input.description.trim();
    const requestedStartMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(input.startMonth)
      ? input.startMonth
      : currentMonthIso();
    const startMonth = requestedStartMonth;
    const original = input.id
      ? this.db.prepare(`
          SELECT kind, description FROM recurring_expenses
          WHERE id = ? AND deleted_at IS NULL
        `).get(id) as Row | undefined
      : undefined;
    const identityChanged = !original
      || original.kind !== kind
      || String(original.description).trim().toLocaleLowerCase('pt-BR') !== description.toLocaleLowerCase('pt-BR');
    const duplicate = identityChanged
      ? this.db.prepare(`
          SELECT id FROM recurring_expenses
          WHERE deleted_at IS NULL AND kind = ? AND LOWER(TRIM(description)) = LOWER(TRIM(?))
            AND id != ?
          LIMIT 1
        `).get(kind, description, id)
      : undefined;
    if (duplicate) {
      const label = kind === 'income' ? 'entrada fixa' : 'saída fixa';
      throw new Error(`Já existe uma ${label} com esse nome. Edite a recorrência existente.`);
    }
    if (input.id) {
      this.db.exec('BEGIN');
      try {
        this.db.prepare(`
          UPDATE recurring_expenses SET kind = ?, active = ?, description = ?, start_month = ?, category_id = ?,
            payment_method_id = ?, planned_cents = ?, due_day = ?, notes = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(
          kind,
          input.active ? 1 : 0,
          description,
          startMonth,
          input.categoryId ?? null,
          input.paymentMethodId ?? null,
          plannedCents,
          dueDay,
          input.notes?.trim() ?? '',
          timestamp,
          id,
        );

        const pendingTransactions = this.db.prepare(`
          SELECT id, due_date AS dueDate
          FROM transactions
          WHERE source_type = 'recurring' AND source_id = ? AND status = 'planned'
            AND actual_cents IS NULL AND settled_date IS NULL AND deleted_at IS NULL
            AND due_date >= ?
        `).all(id, `${startMonth}-01`) as unknown as Row[];
        const updatePending = this.db.prepare(`
          UPDATE transactions SET kind = ?, description = ?, category_id = ?, planned_cents = ?,
            due_date = ?, payment_method_id = ?, notes = ?, updated_at = ?
          WHERE id = ?
        `);
        for (const transaction of pendingTransactions) {
          const month = String(transaction.dueDate).slice(0, 7);
          updatePending.run(
            kind,
            description,
            input.categoryId ?? null,
            plannedCents,
            dateForMonthDay(month, dueDay),
            input.paymentMethodId ?? null,
            input.notes?.trim() ?? '',
            timestamp,
            transaction.id,
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } else {
      this.db.prepare(`
        INSERT INTO recurring_expenses(
          id, kind, active, description, start_month, category_id, payment_method_id, planned_cents,
          due_day, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        kind,
        input.active ? 1 : 0,
        description,
        startMonth,
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        plannedCents,
        dueDay,
        input.notes?.trim() ?? '',
        timestamp,
        timestamp,
      );
    }
    const saved = this.listRecurringExpenses().find((item) => item.id === id);
    if (!saved) throw new Error('Não foi possível salvar a recorrência.');
    return saved;
  }

  deleteRecurringExpense(id: string) {
    const timestamp = now();
    this.db.prepare('UPDATE recurring_expenses SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
      timestamp,
      timestamp,
      id,
    );
  }

  createInstallmentPurchase(input: InstallmentPurchaseInput): InstallmentPurchase {
    const id = randomUUID();
    const timestamp = now();
    const cents = toCents(input.installmentAmount) ?? 0;
    const totalInstallments = Math.round(input.totalInstallments);
    const currentInstallment = Math.round(input.currentInstallment);
    if (totalInstallments < 1 || currentInstallment < 1 || currentInstallment > totalInstallments) {
      throw new Error('Informe uma parcela atual entre 1 e o total da compra.');
    }
    const firstDueDate = addMonths(input.currentDueDate, -(currentInstallment - 1));
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO installment_purchases(
          id, description, category_id, payment_method_id, card_id, installment_cents,
          total_installments, starting_installment, first_due_date, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.description.trim(),
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        cents,
        totalInstallments,
        currentInstallment,
        firstDueDate,
        input.notes?.trim() ?? '',
        timestamp,
        timestamp,
      );
      const statement = this.db.prepare(`
        INSERT INTO transactions(
          id, kind, description, category_id, planned_cents, due_date, status,
          payment_method_id, card_id, notes, source_type, source_id,
          installment_number, installment_total, created_at, updated_at
        ) VALUES (?, 'expense', ?, ?, ?, ?, 'planned', ?, ?, ?, 'installment', ?, ?, ?, ?, ?)
      `);
      for (let installment = currentInstallment; installment <= totalInstallments; installment += 1) {
        statement.run(
          randomUUID(),
          input.description.trim(),
          input.categoryId ?? null,
          cents,
          addMonths(input.currentDueDate, installment - currentInstallment),
          input.paymentMethodId ?? null,
          input.cardId ?? null,
          input.notes?.trim() ?? '',
          id,
          installment,
          totalInstallments,
          timestamp,
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const saved = this.listInstallmentPurchases(input.currentDueDate.slice(0, 7)).find((item) => item.id === id);
    if (!saved) throw new Error('Não foi possível salvar a compra parcelada.');
    return saved;
  }

  listInstallmentPurchases(month: string): InstallmentPurchase[] {
    const { start, end } = monthRange(month);
    const rows = this.db.prepare(`
      SELECT p.id, p.description, p.category_id AS categoryId, c.name AS categoryName,
        p.card_id AS cardId, ca.name AS cardName, p.installment_cents AS installmentCents,
        p.total_installments AS totalInstallments,
        p.starting_installment AS startingInstallment, p.first_due_date AS firstDueDate,
        p.status, p.notes, viewed.installment_number AS viewedInstallment,
        viewed.due_date AS viewedDueDate, viewed.status AS viewedStatus,
        (p.starting_installment - 1) +
          COALESCE(SUM(CASE WHEN progress.status = 'paid' AND progress.deleted_at IS NULL THEN 1 ELSE 0 END), 0)
          AS paidInstallments
      FROM installment_purchases p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN cards ca ON ca.id = p.card_id
      JOIN transactions viewed ON viewed.source_type = 'installment' AND viewed.source_id = p.id
        AND viewed.deleted_at IS NULL AND viewed.due_date >= ? AND viewed.due_date < ?
      LEFT JOIN transactions progress ON progress.source_type = 'installment' AND progress.source_id = p.id
        AND progress.due_date < ?
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY viewed.due_date, p.description COLLATE NOCASE
    `).all(start, end, end) as unknown as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      description: String(row.description),
      categoryId: row.categoryId ? String(row.categoryId) : null,
      categoryName: row.categoryName ? String(row.categoryName) : null,
      cardId: row.cardId ? String(row.cardId) : null,
      cardName: row.cardName ? String(row.cardName) : null,
      installmentAmount: fromCents(Number(row.installmentCents)) ?? 0,
      totalInstallments: Number(row.totalInstallments),
      startingInstallment: Number(row.startingInstallment),
      paidInstallments: Math.min(Number(row.totalInstallments), Number(row.paidInstallments)),
      firstDueDate: String(row.firstDueDate),
      viewedInstallment: Number(row.viewedInstallment),
      viewedDueDate: String(row.viewedDueDate),
      viewedStatus: row.viewedStatus as TransactionStatus,
      status: row.status as InstallmentPurchase['status'],
      notes: String(row.notes ?? ''),
    }));
  }

  deleteInstallmentPurchase(id: string) {
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE installment_purchases SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
        timestamp,
        timestamp,
        id,
      );
      this.db.prepare(`
        UPDATE transactions SET deleted_at = ?, updated_at = ?
        WHERE source_type = 'installment' AND source_id = ? AND status = 'planned'
      `).run(timestamp, timestamp, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private goalFromRow(row: Row): Goal {
    const targetAmount = fromCents(Number(row.targetCents)) ?? 0;
    const savedAmount = fromCents(Number(row.savedCents)) ?? 0;
    const dueDate = row.dueDate ? String(row.dueDate) : null;
    const calculation = calculateGoal(targetAmount, savedAmount, dueDate);
    return {
      id: String(row.id),
      name: String(row.name),
      itemModel: String(row.itemModel ?? ''),
      link: String(row.link ?? ''),
      categoryId: row.categoryId ? String(row.categoryId) : null,
      categoryName: row.categoryName ? String(row.categoryName) : null,
      targetAmount,
      savedAmount,
      ...calculation,
      priority: row.priority as Goal['priority'],
      dueDate,
      status: row.status as Goal['status'],
      notes: String(row.notes ?? ''),
    };
  }

  listGoals(): Goal[] {
    const rows = this.db.prepare(`
      SELECT g.id, g.name, g.item_model AS itemModel, g.link,
        g.category_id AS categoryId, c.name AS categoryName,
        g.target_cents AS targetCents, g.saved_cents AS savedCents,
        g.priority, g.due_date AS dueDate, g.status, g.notes
      FROM goals g
      LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.deleted_at IS NULL
      ORDER BY CASE g.status WHEN 'saving' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        CASE g.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        g.due_date IS NULL, g.due_date
    `).all() as unknown as Row[];
    return rows.map((row) => this.goalFromRow(row));
  }

  saveGoal(input: GoalInput): Goal {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    if (input.id) {
      this.db.prepare(`
        UPDATE goals SET name = ?, item_model = ?, link = ?, category_id = ?, target_cents = ?,
          saved_cents = ?, priority = ?, due_date = ?, status = ?, notes = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        input.name.trim(),
        input.itemModel?.trim() ?? '',
        input.link?.trim() ?? '',
        input.categoryId ?? null,
        toCents(input.targetAmount) ?? 0,
        toCents(input.savedAmount) ?? 0,
        input.priority,
        input.dueDate || null,
        input.status,
        input.notes?.trim() ?? '',
        timestamp,
        id,
      );
    } else {
      this.db.prepare(`
        INSERT INTO goals(
          id, name, item_model, link, category_id, target_cents, saved_cents,
          priority, due_date, status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.name.trim(),
        input.itemModel?.trim() ?? '',
        input.link?.trim() ?? '',
        input.categoryId ?? null,
        toCents(input.targetAmount) ?? 0,
        toCents(input.savedAmount) ?? 0,
        input.priority,
        input.dueDate || null,
        input.status,
        input.notes?.trim() ?? '',
        timestamp,
        timestamp,
      );
    }
    const saved = this.listGoals().find((goal) => goal.id === id);
    if (!saved) throw new Error('Não foi possível salvar o objetivo.');
    return saved;
  }

  deleteGoal(id: string) {
    const timestamp = now();
    this.db.prepare('UPDATE goals SET deleted_at = ?, updated_at = ? WHERE id = ?').run(
      timestamp,
      timestamp,
      id,
    );
  }

  private monthSummary(month: string): MonthSummary {
    this.ensureRecurringForMonth(month);
    const { start, end } = monthRange(month);
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'income' AND status != 'cancelled' THEN planned_cents ELSE 0 END), 0) AS plannedIncome,
        COALESCE(SUM(CASE WHEN kind = 'income' AND status = 'received' THEN COALESCE(actual_cents, planned_cents) ELSE 0 END), 0) AS receivedIncome,
        COALESCE(SUM(CASE WHEN kind = 'expense' AND status != 'cancelled' THEN planned_cents ELSE 0 END), 0) AS plannedExpenses,
        COALESCE(SUM(CASE WHEN kind = 'expense' AND status = 'paid' THEN COALESCE(actual_cents, planned_cents) ELSE 0 END), 0) AS paidExpenses
      FROM transactions t
      WHERE t.deleted_at IS NULL AND ${this.recurringPeriodCondition()}
        AND t.due_date >= ? AND t.due_date < ?
    `).get(start, end) as Row;
    const plannedIncome = fromCents(Number(row.plannedIncome)) ?? 0;
    const receivedIncome = fromCents(Number(row.receivedIncome)) ?? 0;
    const plannedExpenses = fromCents(Number(row.plannedExpenses)) ?? 0;
    const paidExpenses = fromCents(Number(row.paidExpenses)) ?? 0;
    return {
      month,
      plannedIncome,
      receivedIncome,
      plannedExpenses,
      paidExpenses,
      projectedBalance: plannedIncome - plannedExpenses,
      realizedBalance: receivedIncome - paidExpenses,
      committedPercent: plannedIncome > 0 ? plannedExpenses / plannedIncome : 0,
    };
  }

  getOverview(month: string): Overview {
    const year = Number(month.slice(0, 4));
    const annual = Array.from({ length: 12 }, (_, index) =>
      this.monthSummary(`${year}-${String(index + 1).padStart(2, '0')}`),
    );
    const { start, end } = monthRange(month);
    const categoryRows = this.db.prepare(`
      SELECT COALESCE(c.name, 'Sem categoria') AS name,
        COALESCE(c.color, '${NEUTRAL_COLOR}') AS color,
        COALESCE(SUM(CASE WHEN t.status = 'paid' THEN COALESCE(t.actual_cents, t.planned_cents) ELSE t.planned_cents END), 0) AS amount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.kind = 'expense' AND t.status != 'cancelled'
        AND ${this.recurringPeriodCondition()}
        AND t.due_date >= ? AND t.due_date < ?
      GROUP BY c.id, c.name, c.color
      HAVING amount > 0
      ORDER BY amount DESC
    `).all(start, end) as unknown as Row[];

    // "Contas a caminho" são só o que se paga, e só dentro do mês aberto —
    // como o resto do painel. Sem recorte por "hoje": uma conta vencida e não
    // paga continua sendo uma conta a pagar, e some da lista ao ser quitada.
    const upcomingRows = this.db.prepare(`
      ${this.transactionSelect()}
      WHERE t.deleted_at IS NULL AND t.kind = 'expense' AND t.status = 'planned'
        AND ${this.recurringPeriodCondition()}
        AND t.due_date >= ? AND t.due_date < ? AND t.planned_cents > 0
      ORDER BY t.due_date LIMIT 5
    `).all(start, end) as unknown as Row[];

    const recentRows = this.db.prepare(`
      ${this.transactionSelect()}
      WHERE t.deleted_at IS NULL AND t.due_date >= ? AND t.due_date < ?
        AND ${this.recurringPeriodCondition()}
        AND (t.planned_cents > 0 OR COALESCE(t.actual_cents, 0) > 0)
      ORDER BY COALESCE(t.settled_date, t.due_date) DESC, t.updated_at DESC LIMIT 6
    `).all(start, end) as unknown as Row[];

    return {
      summary: this.monthSummary(month),
      annual,
      categoryBreakdown: categoryRows.map((row) => ({
        name: String(row.name),
        color: String(row.color),
        amount: fromCents(Number(row.amount)) ?? 0,
      })),
      upcoming: upcomingRows.map((row) => this.transactionFromRow(row)),
      recent: recentRows.map((row) => this.transactionFromRow(row)),
      goals: this.listGoals().filter((goal) => !['cancelled', 'completed'].includes(goal.status)).slice(0, 3),
    };
  }

  exportData() {
    const tables = [
      'categories',
      'payment_methods',
      'cards',
      'recurring_expenses',
      'installment_purchases',
      'transactions',
      'goals',
    ];
    return Object.fromEntries(
      tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()]),
    );
  }

  exportTransactions(month?: string) {
    const conditions = ['t.deleted_at IS NULL', this.recurringPeriodCondition()];
    const parameters: string[] = [];
    if (month) {
      const { start, end } = monthRange(month);
      conditions.push('t.due_date >= ?', 't.due_date < ?');
      parameters.push(start, end);
    }
    return this.db.prepare(`
      SELECT t.due_date AS data, t.kind AS tipo, t.description AS descricao,
        c.name AS categoria, t.planned_cents / 100.0 AS valor_planejado,
        t.actual_cents / 100.0 AS valor_real, t.status AS situacao,
        pm.name AS forma_pagamento, ca.name AS cartao, t.notes AS observacoes
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
      LEFT JOIN cards ca ON ca.id = t.card_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.due_date, t.description
    `).all(...parameters) as unknown as Row[];
  }
}
