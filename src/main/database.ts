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
  cardStatementDueDate,
  currentMonthIso,
  dateForMonthDay,
  fromCents,
  monthRange,
  nextCardDueDate,
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
        closing_day INTEGER,
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
        card_id TEXT REFERENCES cards(id),
        planned_cents INTEGER NOT NULL DEFAULT 0,
        due_day INTEGER NOT NULL DEFAULT 1,
        charge_day INTEGER,
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
        purchase_date TEXT,
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
        purchase_date TEXT,
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
    if (!cardColumns.some((column) => column.name === 'closing_day')) {
      // Não inventamos o fechamento dos cartões já existentes. Até ele ser
      // configurado, o formulário conserva a regra antiga baseada no vencimento.
      this.db.exec('ALTER TABLE cards ADD COLUMN closing_day INTEGER');
    }
    const transactionColumns = this.db
      .prepare('PRAGMA table_info(transactions)')
      .all() as unknown as Row[];
    if (!transactionColumns.some((column) => column.name === 'purchase_date')) {
      // Lçamentos antigos ficam intocados e continuam no mesmo mês/fatura.
      this.db.exec('ALTER TABLE transactions ADD COLUMN purchase_date TEXT');
    }
    const installmentColumns = this.db
      .prepare('PRAGMA table_info(installment_purchases)')
      .all() as unknown as Row[];
    if (!installmentColumns.some((column) => column.name === 'starting_installment')) {
      this.db.exec(
        'ALTER TABLE installment_purchases ADD COLUMN starting_installment INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!installmentColumns.some((column) => column.name === 'purchase_date')) {
      this.db.exec('ALTER TABLE installment_purchases ADD COLUMN purchase_date TEXT');
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
    if (!recurringColumns.some((column) => column.name === 'card_id')) {
      this.db.exec('ALTER TABLE recurring_expenses ADD COLUMN card_id TEXT REFERENCES cards(id)');
    }
    if (!recurringColumns.some((column) => column.name === 'charge_day')) {
      this.db.exec('ALTER TABLE recurring_expenses ADD COLUMN charge_day INTEGER');
    }
    this.db.prepare(`
      UPDATE recurring_expenses
      SET start_month = substr(created_at, 1, 7)
      WHERE start_month IS NULL OR start_month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
    `).run();
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (4, datetime('now'))");
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (6, datetime('now'))");
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (7, datetime('now'))");
    this.db.exec("INSERT OR IGNORE INTO migrations(version, applied_at) VALUES (8, datetime('now'))");
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
      .prepare('SELECT id, name, due_day AS dueDay, closing_day AS closingDay FROM cards ORDER BY name COLLATE NOCASE')
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
      const closingDay = input.closingDay === null || input.closingDay === undefined
        ? null
        : Math.min(31, Math.max(1, Math.round(input.closingDay)));
      if (input.id) {
        this.db.prepare(`
          UPDATE cards SET name = ?, due_day = ?, closing_day = ?, updated_at = ? WHERE id = ?
        `).run(input.name.trim(), dueDay, closingDay, timestamp, input.id);
      } else {
        this.db.prepare(`
          INSERT OR IGNORE INTO cards(id, name, due_day, closing_day, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), input.name.trim(), dueDay, closingDay, timestamp, timestamp);
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
        this.db.prepare('UPDATE recurring_expenses SET card_id = NULL, charge_day = NULL WHERE card_id = ?').run(id);
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
    this.db.prepare('INSERT INTO cards(id, name, due_day, closing_day, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').run(
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
      purchaseDate: row.purchaseDate ? String(row.purchaseDate) : null,
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
      isOverdue: row.kind === 'expense' && row.status === 'planned' && String(row.dueDate) < todayIso(),
    };
  }

  /**
   * A competência de uma saída pode diferir do vencimento: uma pendência
   * vencida é carregada adiante e um pagamento tardio pertence ao mês em que
   * realmente saiu da conta. O registro original nunca perde o vencimento.
   */
  private expenseCountsInMonth(transaction: Transaction, month: string) {
    if (transaction.kind !== 'expense' || transaction.status === 'cancelled') return false;
    if (transaction.status === 'paid') {
      return (transaction.settledDate ?? transaction.dueDate).slice(0, 7) === month;
    }
    if (transaction.status !== 'planned') return transaction.dueDate.slice(0, 7) === month;
    const dueMonth = transaction.dueDate.slice(0, 7);
    if (dueMonth === month) {
      return !(transaction.isOverdue && month < currentMonthIso());
    }
    return transaction.isOverdue && dueMonth < month;
  }

  private transactionSelect() {
    return `
      SELECT t.id, t.kind, t.description,
        t.category_id AS categoryId, c.name AS categoryName, c.color AS categoryColor,
        t.planned_cents AS plannedCents, t.actual_cents AS actualCents,
        t.purchase_date AS purchaseDate, t.due_date AS dueDate,
        t.settled_date AS settledDate, t.status,
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
          AND COALESCE(substr(${alias}.purchase_date, 1, 7), substr(${alias}.due_date, 1, 7)) < COALESCE(
            recurring_scope.start_month,
            substr(recurring_scope.created_at, 1, 7)
          )
      )
    )`;
  }

  private recurringOccurrence(item: Row, chargeMonth: string) {
    if (item.card_id && item.charge_day !== null) {
      const purchaseDate = dateForMonthDay(chargeMonth, Number(item.charge_day));
      const cardDueDay = Number(item.cardDueDay ?? item.due_day);
      const dueDate = item.cardClosingDay === null
        ? nextCardDueDate(purchaseDate, cardDueDay)
        : cardStatementDueDate(purchaseDate, Number(item.cardClosingDay), cardDueDay);
      return { purchaseDate, dueDate, cardId: String(item.card_id) };
    }
    return {
      purchaseDate: null,
      dueDate: dateForMonthDay(chargeMonth, Number(item.due_day)),
      cardId: null,
    };
  }

  ensureRecurringForMonth(month: string) {
    const recurring = this.db.prepare(`
      SELECT r.*, ca.due_day AS cardDueDay, ca.closing_day AS cardClosingDay
      FROM recurring_expenses r
      LEFT JOIN cards ca ON ca.id = r.card_id
      WHERE r.active = 1 AND r.deleted_at IS NULL
        AND COALESCE(r.start_month, substr(r.created_at, 1, 7)) <= ?
    `).all(month) as unknown as Row[];
    const { start, end } = monthRange(month);
    const existing = this.db.prepare(`
      SELECT id FROM transactions
      WHERE source_type = 'recurring' AND source_id = ? AND due_date >= ? AND due_date < ?
      LIMIT 1
    `);
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO transactions(
        id, kind, description, category_id, planned_cents, purchase_date, due_date, status,
        payment_method_id, card_id, notes, source_type, source_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 'recurring', ?, ?, ?)
    `);
    const timestamp = now();
    for (const item of recurring) {
      // Uma ocorrência excluída continua no banco como um marcador. Considerá-la
      // aqui evita que a consulta do mês recrie imediatamente o lançamento que
      // a pessoa acabou de apagar, sem interromper a recorrência nos outros meses.
      if (existing.get(item.id, start, end)) continue;
      const recurringStartMonth = String(item.start_month ?? String(item.created_at).slice(0, 7));
      // Uma cobrança pode vencer no mesmo mês, no seguinte ou, em ciclos
      // que fecham depois do vencimento, até dois meses adiante.
      for (let offset = 0; offset <= 2; offset += 1) {
        const chargeMonth = addMonths(`${month}-01`, -offset).slice(0, 7);
        if (chargeMonth < recurringStartMonth) continue;
        const occurrence = this.recurringOccurrence(item, chargeMonth);
        if (occurrence.dueDate.slice(0, 7) !== month) continue;
        statement.run(
          randomUUID(),
          item.kind,
          item.description,
          item.category_id,
          item.planned_cents,
          occurrence.purchaseDate,
          occurrence.dueDate,
          item.payment_method_id,
          occurrence.cardId,
          item.notes,
          item.id,
          timestamp,
          timestamp,
        );
        break;
      }
    }
  }

  listTransactions(filters: TransactionFilters): Transaction[] {
    this.ensureRecurringForMonth(filters.month);
    const { start, end } = monthRange(filters.month);
    const today = todayIso();
    const conditions = [
      't.deleted_at IS NULL',
      this.recurringPeriodCondition(),
      `(
        (t.due_date >= ? AND t.due_date < ?)
        OR (
          t.kind = 'expense' AND t.status = 'planned'
          AND t.due_date < ? AND t.due_date < ?
        )
        OR (
          t.kind = 'expense' AND t.status = 'paid'
          AND COALESCE(t.settled_date, t.due_date) >= ?
          AND COALESCE(t.settled_date, t.due_date) < ?
        )
      )`,
    ];
    const parameters: Array<string> = [start, end, today, start, start, end];
    if (filters.kind && filters.kind !== 'all') {
      conditions.push('t.kind = ?');
      parameters.push(filters.kind);
    }
    if (filters.status && filters.status !== 'all') {
      conditions.push('t.status = ?');
      parameters.push(filters.status);
    }
    const creditCardCondition = `(
      t.card_id IS NOT NULL OR
      search_key(COALESCE(pm.name, '')) = search_key('Cartão de crédito')
    )`;
    if (filters.payment === 'creditCard') {
      conditions.push(creditCardCondition);
    } else if (filters.payment === 'other') {
      conditions.push(`NOT ${creditCardCondition}`);
    }
    if (filters.source && filters.source !== 'all') {
      conditions.push('t.source_type = ?');
      parameters.push(filters.source);
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
      .prepare(`${this.transactionSelect()} WHERE ${conditions.join(' AND ')} ORDER BY
        CASE WHEN t.kind = 'expense' AND t.status = 'planned' AND t.due_date < ? THEN 0 ELSE 1 END,
        t.due_date, t.created_at`)
      .all(...parameters, today) as unknown as Row[];
    return rows.map((row) => this.transactionFromRow(row));
  }

  saveTransaction(input: TransactionInput): Transaction {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const actualCents = toCents(input.actualAmount);
    if (input.id) {
      this.db.prepare(`
        UPDATE transactions SET kind = ?, description = ?, category_id = ?, planned_cents = ?,
          actual_cents = ?, purchase_date = ?, due_date = ?, settled_date = ?, status = ?, payment_method_id = ?,
          card_id = ?, notes = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        input.kind,
        input.description.trim(),
        input.categoryId ?? null,
        toCents(input.plannedAmount) ?? 0,
        actualCents,
        input.purchaseDate ?? null,
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
          id, kind, description, category_id, planned_cents, actual_cents, purchase_date, due_date,
          settled_date, status, payment_method_id, card_id, notes, source_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
      `).run(
        id,
        input.kind,
        input.description.trim(),
        input.categoryId ?? null,
        toCents(input.plannedAmount) ?? 0,
        actualCents,
        input.purchaseDate ?? null,
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
        id, kind, description, category_id, planned_cents, actual_cents, purchase_date, due_date,
        settled_date, status, payment_method_id, card_id, notes, source_type, source_id,
        installment_number, installment_total, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.kind,
      input.description.trim(),
      input.categoryId ?? null,
      toCents(input.plannedAmount) ?? 0,
      toCents(input.actualAmount),
      input.purchaseDate ?? null,
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
    `).run(status, todayIso(), now(), id);
  }

  /**
   * Quita uma lista inteira de uma vez — o fecho de um mês antigo em um clique.
   * Cada lançamento vira "pago" ou "recebido" conforme o tipo, assume o valor
   * planejado como valor real e registra o dia em que a ação foi executada.
   */
  settleTransactions(ids: string[]): number {
    if (!ids.length) return 0;
    const timestamp = now();
    const today = todayIso();
    const statement = this.db.prepare(`
      UPDATE transactions
      SET status = CASE kind WHEN 'income' THEN 'received' ELSE 'paid' END,
        actual_cents = COALESCE(actual_cents, planned_cents),
        settled_date = COALESCE(settled_date, ?),
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
        pm.name AS paymentMethodName, r.card_id AS cardId, ca.name AS cardName,
        r.planned_cents AS plannedCents,
        r.due_day AS dueDay, COALESCE(r.start_month, substr(r.created_at, 1, 7)) AS startMonth,
        r.charge_day AS chargeDay, r.notes
      FROM recurring_expenses r
      LEFT JOIN categories c ON c.id = r.category_id
      LEFT JOIN payment_methods pm ON pm.id = r.payment_method_id
      LEFT JOIN cards ca ON ca.id = r.card_id
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
      cardId: row.cardId ? String(row.cardId) : null,
      cardName: row.cardName ? String(row.cardName) : null,
      plannedAmount: fromCents(Number(row.plannedCents)) ?? 0,
      dueDay: Number(row.dueDay),
      chargeDay: row.chargeDay === null ? null : Number(row.chargeDay),
      notes: String(row.notes ?? ''),
    }));
  }

  saveRecurringExpense(input: RecurringExpenseInput): RecurringExpense {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const plannedCents = toCents(input.plannedAmount) ?? 0;
    const kind = input.kind === 'income' ? 'income' : 'expense';
    const requestedCardId = kind === 'expense' ? input.cardId ?? null : null;
    const card = requestedCardId
      ? this.db.prepare(`
          SELECT id, due_day AS cardDueDay, closing_day AS cardClosingDay
          FROM cards WHERE id = ?
        `).get(requestedCardId) as Row | undefined
      : undefined;
    const cardId = card ? String(card.id) : null;
    const chargeDay = cardId
      ? Math.min(31, Math.max(1, Math.round(input.chargeDay ?? 1)))
      : null;
    const dueDay = card
      ? Number(card.cardDueDay)
      : Math.min(31, Math.max(1, input.dueDay));
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
            payment_method_id = ?, card_id = ?, planned_cents = ?, due_day = ?, charge_day = ?, notes = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(
          kind,
          input.active ? 1 : 0,
          description,
          startMonth,
          input.categoryId ?? null,
          input.paymentMethodId ?? null,
          cardId,
          plannedCents,
          dueDay,
          chargeDay,
          input.notes?.trim() ?? '',
          timestamp,
          id,
        );

        const pendingTransactions = this.db.prepare(`
          SELECT id, purchase_date AS purchaseDate, due_date AS dueDate
          FROM transactions
          WHERE source_type = 'recurring' AND source_id = ? AND status = 'planned'
            AND actual_cents IS NULL AND settled_date IS NULL AND deleted_at IS NULL
          ORDER BY due_date
        `).all(id) as unknown as Row[];
        const parkPending = this.db.prepare(`
          UPDATE transactions SET due_date = ?, updated_at = ? WHERE id = ?
        `);
        for (const transaction of pendingTransactions) {
          parkPending.run(`pending-${transaction.id}`, timestamp, transaction.id);
        }
        const updatePending = this.db.prepare(`
          UPDATE transactions SET kind = ?, description = ?, category_id = ?, planned_cents = ?,
            purchase_date = ?, due_date = ?, payment_method_id = ?, card_id = ?, notes = ?, updated_at = ?
          WHERE id = ?
        `);
        const discardPending = this.db.prepare(`
          UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?
        `);
        const findDueDateCollision = this.db.prepare(`
          SELECT id FROM transactions
          WHERE source_type = 'recurring' AND source_id = ? AND due_date = ?
            AND id != ? AND deleted_at IS NULL
          LIMIT 1
        `);
        const occurrenceSettings: Row = {
          card_id: cardId,
          charge_day: chargeDay,
          due_day: dueDay,
          cardDueDay: card?.cardDueDay ?? null,
          cardClosingDay: card?.cardClosingDay ?? null,
        };
        for (const transaction of pendingTransactions) {
          const chargeMonth = transaction.purchaseDate
            ? String(transaction.purchaseDate).slice(0, 7)
            : String(transaction.dueDate).slice(0, 7);
          if (chargeMonth < startMonth) {
            discardPending.run(timestamp, timestamp, transaction.id);
            continue;
          }
          const occurrence = this.recurringOccurrence(occurrenceSettings, chargeMonth);
          // Ao completar o dia de cobrança de uma recorrência antiga, a nova
          // fatura pode coincidir com uma ocorrência que foi paga, cancelada ou
          // ajustada manualmente e, por isso, foi preservada acima. Essa ocorrência
          // existente tem prioridade: removemos somente a projeção planejada que
          // se tornou redundante, em vez de violar o índice único ou alterar o
          // histórico da pessoa.
          if (findDueDateCollision.get(id, occurrence.dueDate, transaction.id)) {
            discardPending.run(timestamp, timestamp, transaction.id);
            continue;
          }
          updatePending.run(
            kind,
            description,
            input.categoryId ?? null,
            plannedCents,
            occurrence.purchaseDate,
            occurrence.dueDate,
            input.paymentMethodId ?? null,
            occurrence.cardId,
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
          id, kind, active, description, start_month, category_id, payment_method_id, card_id,
          planned_cents, due_day, charge_day, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        kind,
        input.active ? 1 : 0,
        description,
        startMonth,
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        cardId,
        plannedCents,
        dueDay,
        chargeDay,
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
          total_installments, starting_installment, purchase_date, first_due_date, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.description.trim(),
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        cents,
        totalInstallments,
        currentInstallment,
        input.purchaseDate ?? null,
        firstDueDate,
        input.notes?.trim() ?? '',
        timestamp,
        timestamp,
      );
      const statement = this.db.prepare(`
        INSERT INTO transactions(
          id, kind, description, category_id, planned_cents, purchase_date, due_date, status,
          payment_method_id, card_id, notes, source_type, source_id,
          installment_number, installment_total, created_at, updated_at
        ) VALUES (?, 'expense', ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 'installment', ?, ?, ?, ?, ?)
      `);
      for (let installment = currentInstallment; installment <= totalInstallments; installment += 1) {
        statement.run(
          randomUUID(),
          input.description.trim(),
          input.categoryId ?? null,
          cents,
          input.purchaseDate ?? null,
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

  saveInstallmentPurchase(input: InstallmentPurchaseInput): InstallmentPurchase {
    if (!input.id) return this.createInstallmentPurchase(input);

    const purchase = this.db.prepare(`
      SELECT id, starting_installment AS startingInstallment
      FROM installment_purchases
      WHERE id = ? AND deleted_at IS NULL
    `).get(input.id) as unknown as Row | undefined;
    if (!purchase) throw new Error('Compra parcelada não encontrada.');

    const timestamp = now();
    const cents = toCents(input.installmentAmount) ?? 0;
    const totalInstallments = Math.round(input.totalInstallments);
    const currentInstallment = Math.round(input.currentInstallment);
    const startingInstallment = Number(purchase.startingInstallment);
    const originalCurrentInstallment = Math.round(input.originalCurrentInstallment ?? currentInstallment);
    const installmentNumberShift = currentInstallment - originalCurrentInstallment;
    const correctedStartingInstallment = startingInstallment + installmentNumberShift;
    const description = input.description.trim();
    if (!description) throw new Error('Informe a descrição da compra.');
    if (cents < 1) throw new Error('Informe um valor de parcela maior que zero.');
    if (
      correctedStartingInstallment < 1
      || totalInstallments < correctedStartingInstallment
      || currentInstallment < correctedStartingInstallment
      || currentInstallment > totalInstallments
    ) {
      throw new Error('Informe uma parcela entre 1 e o total da compra.');
    }

    const transactions = this.db.prepare(`
      SELECT id, installment_number AS installmentNumber, due_date AS dueDate, status
      FROM transactions
      WHERE source_type = 'installment' AND source_id = ? AND deleted_at IS NULL
      ORDER BY installment_number
    `).all(input.id) as unknown as Row[];
    const shiftedTransactions: Array<Row & { installmentNumber: number }> = transactions.map((transaction) => ({
      ...transaction,
      installmentNumber: Number(transaction.installmentNumber) + installmentNumberShift,
    }));
    const highestFinalized = shiftedTransactions.reduce((highest, transaction) =>
      transaction.status !== 'planned'
        ? Math.max(highest, Number(transaction.installmentNumber))
        : highest, 0);
    if (totalInstallments < highestFinalized) {
      throw new Error(`O total não pode ser menor que a parcela ${highestFinalized}, que já foi concluída.`);
    }

    const firstDueDate = addMonths(input.currentDueDate, -(currentInstallment - 1));
    const finalizedDates = new Set(
      shiftedTransactions
        .filter((transaction) => transaction.status !== 'planned')
        .map((transaction) => String(transaction.dueDate)),
    );
    for (let installment = correctedStartingInstallment; installment <= totalInstallments; installment += 1) {
      const existing = shiftedTransactions.find((transaction) => Number(transaction.installmentNumber) === installment);
      if (existing?.status !== 'planned') continue;
      const dueDate = addMonths(firstDueDate, installment - 1);
      if (finalizedDates.has(dueDate)) {
        throw new Error('O novo calendário coincide com uma parcela já concluída. Ajuste a parcela atual ou a data da compra.');
      }
    }

    this.db.exec('BEGIN');
    try {
      if (installmentNumberShift !== 0) {
        this.db.prepare(`
          UPDATE transactions
          SET installment_number = installment_number + ?, updated_at = ?
          WHERE source_type = 'installment' AND source_id = ? AND deleted_at IS NULL
        `).run(installmentNumberShift, timestamp, input.id);
      }
      this.db.prepare(`
        UPDATE transactions
        SET deleted_at = ?, updated_at = ?
        WHERE source_type = 'installment' AND source_id = ? AND status = 'planned'
          AND installment_number > ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, input.id, totalInstallments);
      // Libera temporariamente as datas das parcelas abertas para que mover a
      // série um mês não colida com a próxima parcela no índice único.
      this.db.prepare(`
        UPDATE transactions
        SET due_date = 'editing-' || installment_number || '-' || id
        WHERE source_type = 'installment' AND source_id = ? AND status = 'planned'
          AND installment_number <= ? AND deleted_at IS NULL
      `).run(input.id, totalInstallments);
      this.db.prepare(`
        UPDATE transactions
        SET description = ?, category_id = ?, purchase_date = ?, payment_method_id = ?,
          card_id = ?, notes = ?, installment_total = ?, updated_at = ?
        WHERE source_type = 'installment' AND source_id = ? AND deleted_at IS NULL
      `).run(
        description,
        input.categoryId ?? null,
        input.purchaseDate ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        input.notes?.trim() ?? '',
        totalInstallments,
        timestamp,
        input.id,
      );

      const activeByNumber = new Map(
        shiftedTransactions
          .filter((transaction) => Number(transaction.installmentNumber) <= totalInstallments)
          .map((transaction) => [Number(transaction.installmentNumber), transaction]),
      );
      const insert = this.db.prepare(`
        INSERT INTO transactions(
          id, kind, description, category_id, planned_cents, purchase_date, due_date, status,
          payment_method_id, card_id, notes, source_type, source_id,
          installment_number, installment_total, created_at, updated_at
        ) VALUES (?, 'expense', ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 'installment', ?, ?, ?, ?, ?)
      `);
      const updatePlanned = this.db.prepare(`
        UPDATE transactions
        SET planned_cents = ?, due_date = ?, updated_at = ?
        WHERE id = ? AND status = 'planned' AND deleted_at IS NULL
      `);
      for (let installment = correctedStartingInstallment; installment <= totalInstallments; installment += 1) {
        const dueDate = addMonths(firstDueDate, installment - 1);
        const existing = activeByNumber.get(installment);
        if (existing?.status === 'planned') {
          updatePlanned.run(cents, dueDate, timestamp, existing.id);
        } else if (!existing) {
          insert.run(
            randomUUID(),
            description,
            input.categoryId ?? null,
            cents,
            input.purchaseDate ?? null,
            dueDate,
            input.paymentMethodId ?? null,
            input.cardId ?? null,
            input.notes?.trim() ?? '',
            input.id,
            installment,
            totalInstallments,
            timestamp,
            timestamp,
          );
        }
      }
      const stillPlanned = this.db.prepare(`
        SELECT 1 FROM transactions
        WHERE source_type = 'installment' AND source_id = ? AND status = 'planned'
          AND deleted_at IS NULL LIMIT 1
      `).get(input.id);
      this.db.prepare(`
        UPDATE installment_purchases
        SET description = ?, category_id = ?, payment_method_id = ?, card_id = ?,
          installment_cents = ?, total_installments = ?, starting_installment = ?,
          purchase_date = ?, first_due_date = ?,
          status = ?, notes = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        description,
        input.categoryId ?? null,
        input.paymentMethodId ?? null,
        input.cardId ?? null,
        cents,
        totalInstallments,
        correctedStartingInstallment,
        input.purchaseDate ?? null,
        firstDueDate,
        stillPlanned ? 'active' : 'completed',
        input.notes?.trim() ?? '',
        timestamp,
        input.id,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const viewedDue = this.db.prepare(`
      SELECT due_date AS dueDate FROM transactions
      WHERE source_type = 'installment' AND source_id = ? AND installment_number = ?
        AND deleted_at IS NULL
      LIMIT 1
    `).get(input.id, currentInstallment) as unknown as Row | undefined;
    const viewed = this.listInstallmentPurchases(String(viewedDue?.dueDate ?? input.currentDueDate).slice(0, 7))
      .find((item) => item.id === input.id);
    if (!viewed) throw new Error('Não foi possível carregar a compra parcelada atualizada.');
    return viewed;
  }

  listInstallmentPurchases(month: string): InstallmentPurchase[] {
    const { start, end } = monthRange(month);
    const rows = this.db.prepare(`
      SELECT p.id, p.description, p.category_id AS categoryId, c.name AS categoryName,
        p.card_id AS cardId, ca.name AS cardName, p.installment_cents AS installmentCents,
        p.total_installments AS totalInstallments,
        p.starting_installment AS startingInstallment, p.purchase_date AS purchaseDate,
        p.first_due_date AS firstDueDate,
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
      purchaseDate: row.purchaseDate ? String(row.purchaseDate) : null,
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
    const transactions = this.listTransactions({ month });
    let plannedIncome = 0;
    let receivedIncome = 0;
    let plannedExpenses = 0;
    let paidExpenses = 0;
    let overdueExpenses = 0;
    for (const transaction of transactions) {
      if (transaction.status === 'cancelled') continue;
      if (transaction.kind === 'income') {
        plannedIncome += transaction.plannedAmount;
        if (transaction.status === 'received') {
          receivedIncome += transaction.actualAmount ?? transaction.plannedAmount;
        }
        continue;
      }
      if (!this.expenseCountsInMonth(transaction, month)) continue;
      plannedExpenses += transaction.plannedAmount;
      if (transaction.status === 'paid') {
        paidExpenses += transaction.actualAmount ?? transaction.plannedAmount;
      }
      if (transaction.isOverdue) overdueExpenses += transaction.plannedAmount;
    }
    return {
      month,
      plannedIncome,
      receivedIncome,
      plannedExpenses,
      paidExpenses,
      overdueExpenses,
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
    const monthlyTransactions = this.listTransactions({ month });
    const countedExpenses = monthlyTransactions.filter((transaction) =>
      transaction.kind === 'expense'
      && transaction.status !== 'cancelled'
      && this.expenseCountsInMonth(transaction, month));
    const categoryMap = new Map<string, { name: string; color: string; amount: number }>();
    for (const transaction of countedExpenses) {
      const key = transaction.categoryId ?? 'uncategorized';
      const current = categoryMap.get(key) ?? {
        name: transaction.categoryName ?? 'Sem categoria',
        color: transaction.categoryColor ?? NEUTRAL_COLOR,
        amount: 0,
      };
      current.amount += transaction.status === 'paid'
        ? transaction.actualAmount ?? transaction.plannedAmount
        : transaction.plannedAmount;
      categoryMap.set(key, current);
    }
    const categoryBreakdown = [...categoryMap.values()]
      .filter((category) => category.amount > 0)
      .sort((left, right) => right.amount - left.amount);
    const upcoming = countedExpenses
      .filter((transaction) => transaction.status === 'planned' && transaction.plannedAmount > 0)
      .sort((left, right) => Number(right.isOverdue) - Number(left.isOverdue)
        || left.dueDate.localeCompare(right.dueDate)
        || left.description.localeCompare(right.description, 'pt-BR'));
    const recent = monthlyTransactions
      .filter((transaction) => (
        transaction.kind === 'income'
        || this.expenseCountsInMonth(transaction, month)
      ) && (transaction.plannedAmount > 0 || (transaction.actualAmount ?? 0) > 0))
      .sort((left, right) => (right.settledDate ?? right.dueDate).localeCompare(left.settledDate ?? left.dueDate))
      .slice(0, 6);

    return {
      summary: this.monthSummary(month),
      annual,
      categoryBreakdown,
      upcoming,
      recent,
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
      SELECT t.purchase_date AS data_compra, t.due_date AS data,
        t.kind AS tipo, t.description AS descricao,
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
