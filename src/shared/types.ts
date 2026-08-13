export type MoneyKind = 'income' | 'expense';
export type TransactionStatus = 'planned' | 'paid' | 'received' | 'cancelled';

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

export interface Transaction {
  id: string;
  kind: MoneyKind;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  plannedAmount: number;
  actualAmount: number | null;
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
}

export interface TransactionInput {
  id?: string;
  kind: MoneyKind;
  description: string;
  categoryId?: string | null;
  plannedAmount: number;
  actualAmount?: number | null;
  dueDate: string;
  settledDate?: string | null;
  status: TransactionStatus;
  paymentMethodId?: string | null;
  cardId?: string | null;
  notes?: string;
}

export interface TransactionFilters {
  month: string;
  kind?: MoneyKind | 'all';
  status?: TransactionStatus | 'all';
  search?: string;
}

export interface RecurringExpense {
  id: string;
  active: boolean;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  plannedAmount: number;
  dueDay: number;
  notes: string;
}

export interface RecurringExpenseInput {
  id?: string;
  active: boolean;
  description: string;
  categoryId?: string | null;
  paymentMethodId?: string | null;
  plannedAmount: number;
  dueDay: number;
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
  paidInstallments: number;
  firstDueDate: string;
  status: 'active' | 'completed' | 'cancelled';
  notes: string;
}

export interface InstallmentPurchaseInput {
  description: string;
  categoryId?: string | null;
  cardId?: string | null;
  paymentMethodId?: string | null;
  installmentAmount: number;
  totalInstallments: number;
  firstDueDate: string;
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
  cards: SimpleCatalogItem[];
}

export interface CatalogInput {
  type: 'category' | 'paymentMethod' | 'card';
  name: string;
  kind?: MoneyKind;
  color?: string;
}

export interface ImportResult {
  categories: number;
  recurringExpenses: number;
  transactions: number;
  goals: number;
}

export interface LionPocketApi {
  getCatalogs(): Promise<Catalogs>;
  createCatalogItem(input: CatalogInput): Promise<void>;
  getOverview(month: string): Promise<Overview>;
  listTransactions(filters: TransactionFilters): Promise<Transaction[]>;
  saveTransaction(input: TransactionInput): Promise<Transaction>;
  deleteTransaction(id: string): Promise<void>;
  settleTransaction(id: string): Promise<void>;
  listRecurringExpenses(): Promise<RecurringExpense[]>;
  saveRecurringExpense(input: RecurringExpenseInput): Promise<RecurringExpense>;
  deleteRecurringExpense(id: string): Promise<void>;
  listInstallmentPurchases(): Promise<InstallmentPurchase[]>;
  createInstallmentPurchase(input: InstallmentPurchaseInput): Promise<InstallmentPurchase>;
  deleteInstallmentPurchase(id: string): Promise<void>;
  listGoals(): Promise<Goal[]>;
  saveGoal(input: GoalInput): Promise<Goal>;
  deleteGoal(id: string): Promise<void>;
  createBackup(): Promise<string | null>;
  exportCsv(month?: string): Promise<string | null>;
  exportJson(): Promise<string | null>;
  importSpreadsheet(): Promise<ImportResult | null>;
  openExternal(url: string): Promise<void>;
}

