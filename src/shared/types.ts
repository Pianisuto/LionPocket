export type MoneyKind = 'income' | 'expense';
export type TransactionStatus = 'planned' | 'paid' | 'received' | 'cancelled';
export type RecurringFrequency = 'once' | 'weekly' | 'monthly' | 'custom' | 'manual';
export type RecurringIntervalUnit = 'days' | 'weeks' | 'months' | 'years';

export interface Category {
  id: string;
  name: string;
  kind: MoneyKind;
  color: string;
}

export interface SimpleCatalogItem {
  id: string;
  name: string;
}

export interface CreditCard extends SimpleCatalogItem {
  dueDay: number;
  /** Nulo em cartões antigos, até a pessoa informar o fechamento. */
  closingDay: number | null;
}

export interface Transaction {
  id: string;
  kind: MoneyKind;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  plannedAmount: number;
  actualAmount: number | null;
  /** Dia em que a compra foi feita. Usado para descobrir a fatura do cartão. */
  purchaseDate: string | null;
  dueDate: string;
  settledDate: string | null;
  status: TransactionStatus;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  cardId: string | null;
  cardName: string | null;
  notes: string;
  sourceType: 'manual' | 'recurring' | 'installment' | 'imported';
  sourceId: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  /** Derivado em tempo de consulta; o status persistido continua sendo planned. */
  isOverdue: boolean;
}

export interface TransactionInput {
  id?: string;
  kind: MoneyKind;
  description: string;
  categoryId?: string | null;
  plannedAmount: number;
  actualAmount?: number | null;
  purchaseDate?: string | null;
  dueDate: string;
  settledDate?: string | null;
  status: TransactionStatus;
  paymentMethodId?: string | null;
  cardId?: string | null;
  notes?: string;
}

/**
 * O que o app já aprendeu sobre uma descrição usada antes: serve para repetir
 * um lançamento parecido sem redigitar categoria, forma de pagamento e valor.
 */
export interface TransactionSuggestion {
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  paymentMethodId: string | null;
  cardId: string | null;
  amount: number;
  uses: number;
}

export interface TransactionFilters {
  month: string;
  kind?: MoneyKind | 'all';
  status?: TransactionStatus | 'all';
  payment?: 'all' | 'creditCard' | 'other';
  source?: Transaction['sourceType'] | 'all';
  search?: string;
}

export interface RecurringExpense {
  id: string;
  kind: MoneyKind;
  active: boolean;
  description: string;
  startMonth: string;
  /** Data da primeira ocorrência. Recorrências mensais antigas a derivam de startMonth + dia. */
  startDate: string;
  frequency: RecurringFrequency;
  intervalCount: number;
  intervalUnit: RecurringIntervalUnit;
  /** Em intervalos personalizados, desloca a previsão conforme a última data efetiva. */
  anchorToActual: boolean;
  /** Meses do ano (01–12) escolhidos explicitamente quando a frequência é manual. */
  manualMonths: string[];
  categoryId: string | null;
  categoryName: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  cardId: string | null;
  cardName: string | null;
  plannedAmount: number;
  dueDay: number;
  /** Dia mensal em que a despesa é cobrada no cartão. */
  chargeDay: number | null;
  notes: string;
}

export interface RecurringExpenseInput {
  id?: string;
  kind: MoneyKind;
  active: boolean;
  description: string;
  startMonth: string;
  startDate?: string;
  frequency?: RecurringFrequency;
  intervalCount?: number;
  intervalUnit?: RecurringIntervalUnit;
  anchorToActual?: boolean;
  manualMonths?: string[];
  categoryId?: string | null;
  paymentMethodId?: string | null;
  cardId?: string | null;
  plannedAmount: number;
  dueDay: number;
  chargeDay?: number | null;
  notes?: string;
}

export interface InstallmentPurchase {
  id: string;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  cardId: string | null;
  cardName: string | null;
  installmentAmount: number;
  totalInstallments: number;
  startingInstallment: number;
  paidInstallments: number;
  purchaseDate: string | null;
  firstDueDate: string;
  viewedInstallment: number;
  viewedDueDate: string;
  viewedStatus: TransactionStatus;
  status: 'active' | 'completed' | 'cancelled';
  notes: string;
}

export interface InstallmentPurchaseInput {
  id?: string;
  description: string;
  categoryId?: string | null;
  cardId?: string | null;
  paymentMethodId?: string | null;
  installmentAmount: number;
  totalInstallments: number;
  currentInstallment: number;
  originalCurrentInstallment?: number;
  purchaseDate?: string | null;
  currentDueDate: string;
  notes?: string;
}

export type GoalStatus = 'planned' | 'saving' | 'completed' | 'paused' | 'cancelled';
export type GoalPriority = 'high' | 'medium' | 'low';

export interface Goal {
  id: string;
  name: string;
  itemModel: string;
  link: string;
  categoryId: string | null;
  categoryName: string | null;
  targetAmount: number;
  savedAmount: number;
  remainingAmount: number;
  progress: number;
  priority: GoalPriority;
  dueDate: string | null;
  status: GoalStatus;
  suggestedMonthlyAmount: number | null;
  notes: string;
}

export interface GoalInput {
  id?: string;
  name: string;
  itemModel?: string;
  link?: string;
  categoryId?: string | null;
  targetAmount: number;
  savedAmount: number;
  priority: GoalPriority;
  dueDate?: string | null;
  status: GoalStatus;
  notes?: string;
}

export interface MonthSummary {
  month: string;
  plannedIncome: number;
  receivedIncome: number;
  plannedExpenses: number;
  paidExpenses: number;
  overdueExpenses: number;
  projectedBalance: number;
  realizedBalance: number;
  committedPercent: number;
}

export interface CategorySummary {
  name: string;
  color: string;
  amount: number;
}

export interface Overview {
  summary: MonthSummary;
  annual: MonthSummary[];
  categoryBreakdown: CategorySummary[];
  upcoming: Transaction[];
  recent: Transaction[];
  goals: Goal[];
}

export interface Catalogs {
  categories: Category[];
  paymentMethods: SimpleCatalogItem[];
  cards: CreditCard[];
}

export interface CatalogInput {
  id?: string;
  type: 'category' | 'paymentMethod' | 'card';
  name: string;
  kind?: MoneyKind;
  color?: string;
  dueDay?: number;
  closingDay?: number | null;
}

export interface ImportResult {
  categories: number;
  recurringExpenses: number;
  transactions: number;
  goals: number;
}

export interface WindowState {
  maximized: boolean;
}

export interface UpdateInfo {
  version: string | null;
}

export interface LionPocketApi {
  getCatalogs(): Promise<Catalogs>;
  createCatalogItem(input: CatalogInput): Promise<void>;
  deleteCatalogItem(type: 'category' | 'card', id: string): Promise<void>;
  getOverview(month: string): Promise<Overview>;
  listTransactions(filters: TransactionFilters): Promise<Transaction[]>;
  saveTransaction(input: TransactionInput): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  settleTransaction(id: string): Promise<void>;
  /** Quita vários de uma vez. Devolve quantos realmente mudaram de situação. */
  settleTransactions(ids: string[]): Promise<number>;
  suggestTransactions(kind: MoneyKind, term: string): Promise<TransactionSuggestion[]>;
  listRecurringExpenses(): Promise<RecurringExpense[]>;
  saveRecurringExpense(input: RecurringExpenseInput): Promise<RecurringExpense>;
  deleteRecurringExpense(id: string): Promise<void>;
  listInstallmentPurchases(month: string): Promise<InstallmentPurchase[]>;
  createInstallmentPurchase(input: InstallmentPurchaseInput): Promise<InstallmentPurchase>;
  saveInstallmentPurchase(input: InstallmentPurchaseInput): Promise<InstallmentPurchase>;
  deleteInstallmentPurchase(id: string): Promise<void>;
  listGoals(): Promise<Goal[]>;
  saveGoal(input: GoalInput): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
  createBackup(): Promise<string | null>;
  exportCsv(month?: string): Promise<string | null>;
  exportJson(): Promise<string | null>;
  importSpreadsheet(): Promise<ImportResult | null>;
  openExternal(url: string): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  installUpdate(): Promise<void>;
  /** Avisa quando uma atualização já foi baixada e pode ser instalada. */
  onUpdateDownloaded(listener: (info: UpdateInfo) => void): () => void;
  /** Avisa quando a janela é maximizada ou restaurada. Devolve o cancelamento. */
  onWindowState(listener: (state: WindowState) => void): () => void;
}
