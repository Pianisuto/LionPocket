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
  /** Derivado da configuração separada de prioridades do mês. */
  priorityPosition: number | null;
}

export interface TransactionPriorityInput {
  month: string;
  transactionId: string;
  pinned: boolean;
  /** Insere antes deste item; nulo envia para o fim da seção. */
  beforeTransactionId?: string | null;
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
  planning?: MonthlyPlanningBalance;
  /** Derivado de margem + reforços; ausente em visões antigas, nunca persistido nem sincronizado. */
  protection?: ProtectionBalance;
  /** Só existe quando o mês consultado é o mês atual. */
  freeNow?: FreeNow | null;
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

/** Planejamento por mês; não é movimento financeiro. Zero desativa a margem. */
export interface MonthlyPlanning {
  month: string;
  safetyMarginCents: number;
}
export interface MonthlyPlanningBalance {
  projectedBalance: number;
  safetyMargin: number;
  balanceAfterSafetyMargin: number;
}

/**
 * Reforço planejado para um objetivo em um mês específico. É decisão do usuário,
 * não lançamento: não altera savedAmount, progresso nem cria movimentação.
 * Zero (ou ausência) significa "sem reforço"; nada vale para outros meses.
 */
export interface GoalMonthlyReinforcement {
  goalId: string;
  month: string;
  amountCents: number;
}
export interface GoalReinforcementItem {
  goalId: string;
  status: GoalStatus;
  amountCents: number;
  /** Só objetivos planned/saving contam como valor protegido no mês. */
  counted: boolean;
  /** Pode definir ou aumentar o reforço (planned/saving). */
  editable: boolean;
}
export interface GoalReinforcementPlan {
  month: string;
  totalCents: number;
  items: GoalReinforcementItem[];
}

/** Dinheiro protegido de um mês: margem de segurança + reforços ativos dos objetivos. Derivado. */
export interface ProtectedMoney {
  month: string;
  safetyMarginCents: number;
  goalReinforcementCents: number;
  protectedMoneyCents: number;
}
export interface ProtectionBalance extends ProtectedMoney {
  projectedBalanceCents: number;
  balanceAfterProtectionCents: number;
}
/** Receitas previstas, ainda não recebidas, que caem no primeiro dia com entrada. */
export interface NextIncome {
  date: string;
  /** Soma das entradas previstas nessa data. */
  amountCents: number;
  count: number;
  /** Descrição da entrada quando é uma só; nulo quando há várias na mesma data. */
  description: string | null;
}
/**
 * "Livre agora": o que sobra do saldo realizado do mês depois das contas que vencem até a
 * próxima entrada e do dinheiro protegido. Pode ser negativo. Não é saldo bancário.
 */
export interface FreeNow extends ProtectedMoney {
  today: string;
  /** Recebido - pago no mês; o LionPocket não conhece saldo de conta nem sobra de meses anteriores. */
  realizedBalanceCents: number;
  nextIncome: NextIncome | null;
  /** Último dia (inclusive) dos compromissos: a data da próxima entrada ou o fim do mês. */
  commitmentsUntil: string;
  commitmentsBeforeNextIncomeCents: number;
  freeNowCents: number;
}
