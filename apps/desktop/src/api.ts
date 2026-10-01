import type {
  CatalogInput,
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  MoneyKind,
  Overview,
  RecurringExpense,
  RecurringExpenseInput,
  Transaction,
  TransactionFilters,
  TransactionInput,
  TransactionPriorityInput,
  TransactionSuggestion,
} from '@lionpocket/core/types';

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
  onBetaSyncChanged?(listener: () => void): () => void;
  betaSyncStatus?(): Promise<import('@lionpocket/sync-local').BetaStatus|null>;
  betaSyncCommand?(action:string,args:unknown[]):Promise<unknown>;
  developmentSyncStatus?(): Promise<import('@lionpocket/sync-local').DevelopmentSyncStatus | null>;
  developmentSyncRun?(): Promise<import('@lionpocket/sync-local').DevelopmentSyncStatus>;
  developmentSyncResolve?(objectId: string, heads: string[], revisionId: string, recover: boolean): Promise<import('@lionpocket/sync-local').DevelopmentSyncStatus>;
  getCatalogs(): Promise<Catalogs>;
  createCatalogItem(input: CatalogInput): Promise<void>;
  deleteCatalogItem(type: 'category' | 'card', id: string): Promise<void>;
  getOverview(month: string): Promise<Overview>;
  listTransactions(filters: TransactionFilters): Promise<Transaction[]>;
  setTransactionPriority(input: TransactionPriorityInput): Promise<void>;
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
