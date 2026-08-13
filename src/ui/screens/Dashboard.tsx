import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  CircleDollarSign,
  PiggyBank,
  Plus,
  ReceiptText,
  Sparkles,
  Target,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import type { Overview, Transaction } from '../../shared/types';
import { EmptyState, ProgressBar, Skeleton } from '../components';
import { compactCurrency, currency, formatDate } from '../format';

const MetricCard = ({
  label,
  value,
  hint,
  tone,
  icon,
  displayValue,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'income' | 'expense' | 'balance' | 'neutral';
  icon: React.ReactNode;
  displayValue?: string;
}) => (
  <article className={`metric-card metric-card--${tone}`}>
    <div className="metric-card__top">
      <span>{label}</span>
      <div className="metric-card__icon">{icon}</div>
    </div>
    <strong>{displayValue ?? currency.format(value)}</strong>
    <small>{hint}</small>
  </article>
);

const AnnualChart = ({ overview }: { overview: Overview }) => {
  const values = overview.annual.flatMap((item) => [item.plannedIncome, item.plannedExpenses]);
  const max = Math.max(...values, 1);
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return (
    <div className="annual-chart">
      {overview.annual.map((item, index) => (
        <div className="annual-chart__month" key={item.month} title={`${months[index]} — entradas ${currency.format(item.plannedIncome)}, saídas ${currency.format(item.plannedExpenses)}`}>
          <div className="annual-chart__bars">
            <span className="annual-chart__bar annual-chart__bar--income" style={{ height: `${Math.max(4, (item.plannedIncome / max) * 100)}%` }} />
            <span className="annual-chart__bar annual-chart__bar--expense" style={{ height: `${Math.max(4, (item.plannedExpenses / max) * 100)}%` }} />
          </div>
          <small>{months[index]}</small>
        </div>
      ))}
    </div>
  );
};

const TransactionRow = ({ item }: { item: Transaction }) => {
  const isIncome = item.kind === 'income';
  return (
    <div className="mini-transaction">
      <div className="category-dot" style={{ background: item.categoryColor ?? '#89918B' }}>
        {isIncome ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
      </div>
      <div className="mini-transaction__copy">
        <strong>{item.description}</strong>
        <span>{item.categoryName ?? 'Sem categoria'} · {formatDate(item.dueDate)}</span>
      </div>
      <strong className={isIncome ? 'money-positive' : 'money-negative'}>
        {isIncome ? '+' : '−'} {currency.format(item.actualAmount ?? item.plannedAmount)}
      </strong>
    </div>
  );
};

export const Dashboard = ({
  overview,
  loading,
  onAddTransaction,
  onNavigate,
}: {
  overview: Overview | null;
  loading: boolean;
  onAddTransaction: () => void;
  onNavigate: (view: string) => void;
}) => {
  if (loading || !overview) {
    return <div className="dashboard-grid"><Skeleton className="skeleton--hero" /><Skeleton className="skeleton--hero" /><Skeleton className="skeleton--panel" /><Skeleton className="skeleton--panel" /></div>;
  }

  const { summary } = overview;
  const totalCategories = overview.categoryBreakdown.reduce((sum, item) => sum + item.amount, 0);
  const gradient = overview.categoryBreakdown.length
    ? overview.categoryBreakdown.reduce<{ stops: string[]; progress: number }>((result, item) => {
        const start = result.progress;
        const end = start + (item.amount / totalCategories) * 100;
        result.stops.push(`${item.color} ${start}% ${end}%`);
        result.progress = end;
        return result;
      }, { stops: [], progress: 0 }).stops.join(', ')
    : '#E4E7DF 0 100%';

  return (
    <div className="dashboard">
      <section className="welcome-banner">
        <div>
          <span className="eyebrow"><Sparkles size={15} /> Visão do mês</span>
          <h2>Seu dinheiro está sob controle.</h2>
          <p>Planeje com calma, confirme o que aconteceu e deixe o LionPocket cuidar das contas.</p>
        </div>
        <button className="button button--sun" onClick={onAddTransaction}><Plus size={18} /> Novo lançamento</button>
        <div className="welcome-banner__orb welcome-banner__orb--one" />
        <div className="welcome-banner__orb welcome-banner__orb--two" />
      </section>

      <section className="metric-grid">
        <MetricCard label="Entradas planejadas" value={summary.plannedIncome} hint={`${currency.format(summary.receivedIncome)} já recebidos`} tone="income" icon={<ArrowUpRight size={20} />} />
        <MetricCard label="Saídas planejadas" value={summary.plannedExpenses} hint={`${currency.format(summary.paidExpenses)} já pagos`} tone="expense" icon={<ReceiptText size={20} />} />
        <MetricCard label="Saldo projetado" value={summary.projectedBalance} hint="Se tudo ocorrer como planejado" tone="balance" icon={<TrendingUp size={20} />} />
        <MetricCard label="Renda comprometida" value={summary.committedPercent} displayValue={`${Math.round(summary.committedPercent * 100)}%`} hint="do que deve entrar" tone="neutral" icon={<WalletCards size={20} />} />
      </section>

      <div className="dashboard-grid">
        <section className="panel panel--wide">
          <header className="panel__header">
            <div><span className="eyebrow">Panorama anual</span><h3>Entradas e saídas</h3></div>
            <div className="chart-legend"><span><i className="legend-income" /> Entradas</span><span><i className="legend-expense" /> Saídas</span></div>
          </header>
          <AnnualChart overview={overview} />
        </section>

        <section className="panel spending-panel">
          <header className="panel__header"><div><span className="eyebrow">Distribuição</span><h3>Para onde vai</h3></div></header>
          {overview.categoryBreakdown.length ? (
            <>
              <div className="donut-wrap">
                <div className="donut" style={{ background: `conic-gradient(${gradient})` }}><div><span>Total</span><strong>{compactCurrency.format(totalCategories)}</strong></div></div>
              </div>
              <div className="category-legend">
                {overview.categoryBreakdown.slice(0, 4).map((item) => (
                  <div key={item.name}><span><i style={{ background: item.color }} />{item.name}</span><strong>{currency.format(item.amount)}</strong></div>
                ))}
              </div>
            </>
          ) : <EmptyState icon={<CircleDollarSign />} title="Tudo tranquilo por aqui" description="As categorias aparecem quando você adiciona suas saídas." />}
        </section>

        <section className="panel">
          <header className="panel__header">
            <div><span className="eyebrow">Próximos dias</span><h3>Contas a caminho</h3></div>
            <button className="text-button" onClick={() => onNavigate('transactions')}>Ver todas <ChevronRight size={16} /></button>
          </header>
          <div className="upcoming-list">
            {overview.upcoming.length ? overview.upcoming.map((item) => (
              <div className="upcoming-item" key={item.id}>
                <div className="date-badge"><strong>{formatDate(item.dueDate, 'dd')}</strong><span>{formatDate(item.dueDate, 'MMM')}</span></div>
                <div><strong>{item.description}</strong><span>{item.categoryName ?? 'Sem categoria'}</span></div>
                <strong>{currency.format(item.plannedAmount)}</strong>
              </div>
            )) : <EmptyState icon={<CalendarClock />} title="Nenhuma conta próxima" description="Os próximos vencimentos aparecerão aqui." />}
          </div>
        </section>

        <section className="panel">
          <header className="panel__header">
            <div><span className="eyebrow">Últimos movimentos</span><h3>Atividade do mês</h3></div>
            <button className="text-button" onClick={() => onNavigate('transactions')}>Abrir lista <ChevronRight size={16} /></button>
          </header>
          <div className="mini-list">
            {overview.recent.length ? overview.recent.map((item) => <TransactionRow key={item.id} item={item} />) : <EmptyState icon={<ReceiptText />} title="Seu mês começa aqui" description="Adicione a primeira entrada ou saída para acompanhar o movimento." action={<button className="button button--soft" onClick={onAddTransaction}><Plus size={16} /> Adicionar</button>} />}
          </div>
        </section>

        <section className="panel panel--goals">
          <header className="panel__header">
            <div><span className="eyebrow">Planos em andamento</span><h3>Seus objetivos</h3></div>
            <button className="text-button" onClick={() => onNavigate('goals')}>Ver objetivos <ChevronRight size={16} /></button>
          </header>
          {overview.goals.length ? (
            <div className="goal-mini-grid">
              {overview.goals.map((goal) => (
                <article className="goal-mini" key={goal.id}>
                  <div className="goal-mini__icon"><Target size={20} /></div>
                  <div className="goal-mini__copy"><strong>{goal.name}</strong><span>{currency.format(goal.savedAmount)} de {currency.format(goal.targetAmount)}</span><ProgressBar value={goal.progress} /></div>
                  <strong>{Math.round(goal.progress * 100)}%</strong>
                </article>
              ))}
            </div>
          ) : <EmptyState icon={<PiggyBank />} title="Um sonho cabe aqui" description="Crie um objetivo para acompanhar quanto já guardou e quanto ainda falta." action={<button className="button button--soft" onClick={() => onNavigate('goals')}><Plus size={16} /> Criar objetivo</button>} />}
        </section>
      </div>
    </div>
  );
};
