import { useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronRight,
  CircleDollarSign,
  PiggyBank,
  Plus,
  ReceiptText,
  Target,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import type { Overview, Transaction } from '../../shared/types';
import { EmptyState, ProgressBar, Skeleton } from '../components';
import { compactCurrency, currency, formatDate, monthLabel } from '../format';

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
  const [activeBar, setActiveBar] = useState<{ month: string; kind: 'income' | 'expense' } | null>(null);
  const values = overview.annual.flatMap((item) => [item.plannedIncome, item.plannedExpenses]);
  const max = Math.max(...values, 1);
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return (
    <div className="annual-chart">
      {overview.annual.map((item, index) => {
        const activeKind = activeBar?.month === item.month ? activeBar.kind : null;
        const activate = (kind: 'income' | 'expense') => setActiveBar({ month: item.month, kind });
        const toggle = (kind: 'income' | 'expense') => setActiveBar((current) =>
          current?.month === item.month && current.kind === kind ? null : { month: item.month, kind },
        );
        return <div className="annual-chart__month" key={item.month}>
          <div className="annual-chart__bars">
            <button
              type="button"
              className="annual-chart__bar annual-chart__bar--income"
              style={{ height: `${Math.max(4, (item.plannedIncome / max) * 100)}%` }}
              aria-label={`${monthLabel(item.month)}: entradas ${currency.format(item.plannedIncome)}`}
              onMouseEnter={() => activate('income')}
              onMouseLeave={() => setActiveBar(null)}
              onFocus={() => activate('income')}
              onBlur={() => setActiveBar(null)}
              onClick={() => toggle('income')}
            />
            <button
              type="button"
              className="annual-chart__bar annual-chart__bar--expense"
              style={{ height: `${Math.max(4, (item.plannedExpenses / max) * 100)}%` }}
              aria-label={`${monthLabel(item.month)}: saídas ${currency.format(item.plannedExpenses)}`}
              onMouseEnter={() => activate('expense')}
              onMouseLeave={() => setActiveBar(null)}
              onFocus={() => activate('expense')}
              onBlur={() => setActiveBar(null)}
              onClick={() => toggle('expense')}
            />
          </div>
          <small>{months[index]}</small>
          {activeKind && (
            <div className={`chart-tooltip chart-tooltip--annual ${index < 2 ? 'is-left' : ''} ${index > 9 ? 'is-right' : ''}`} role="tooltip">
              <strong>{monthLabel(item.month)}</strong>
              {activeKind === 'income'
                ? <span><i className="legend-income" /> Entradas <b className="money-positive">{currency.format(item.plannedIncome)}</b></span>
                : <span><i className="legend-expense" /> Saídas <b className="money-negative">{currency.format(item.plannedExpenses)}</b></span>}
            </div>
          )}
        </div>;
      })}
    </div>
  );
};

const SpendingChart = ({ overview, total }: {
  overview: Overview;
  total: number;
}) => {
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  let progress = 0;
  const segments = overview.categoryBreakdown.map((item, index) => {
    const percentage = total > 0 ? (item.amount / total) * 100 : 0;
    const segment = { item, index, percentage, offset: progress };
    progress += percentage;
    return segment;
  });
  const gradient = segments
    .map(({ item, percentage, offset }) => `${item.color} ${offset}% ${offset + percentage}%`)
    .join(', ');
  const selectedSegment = activeCategory === null ? null : segments[activeCategory];
  const highlightGradient = selectedSegment
    ? `conic-gradient(transparent 0 ${selectedSegment.offset}%, rgba(255, 255, 255, 0.16) ${selectedSegment.offset}% ${selectedSegment.offset + selectedSegment.percentage}%, transparent ${selectedSegment.offset + selectedSegment.percentage}% 100%)`
    : 'none';
  const tooltipPosition = selectedSegment ? (() => {
    const angle = ((selectedSegment.offset + selectedSegment.percentage / 2) / 100) * Math.PI * 2 - Math.PI / 2;
    const xDirection = Math.cos(angle);
    const yDirection = Math.sin(angle);
    const radius = 58;
    const verticalTransform = yDirection > 0
      ? 'translate(-50%, 10px)'
      : 'translate(-50%, calc(-100% - 10px))';
    const transform = Math.abs(xDirection) > Math.abs(yDirection) && xDirection > 0
      ? 'translate(10px, -50%)'
      : verticalTransform;
    return {
      left: `${50 + xDirection * radius}%`,
      top: `${50 + yDirection * radius}%`,
      transform,
    };
  })() : undefined;
  return (
    <div className="spending-body" onMouseLeave={() => setActiveCategory(null)}>
      <div className="donut-wrap">
        <div className="donut" style={{ background: `conic-gradient(${gradient})` }} aria-label={`Total distribuído: ${currency.format(total)}`}>
          <svg className="donut__segments" viewBox="0 0 100 100" role="img" aria-label="Distribuição das saídas por categoria">
            {segments.map(({ item, index, percentage, offset }) => (
              <circle
                className={`donut__segment ${activeCategory === index ? 'is-active' : ''}`}
                key={item.name}
                cx="50"
                cy="50"
                r="42"
                pathLength="100"
                stroke="rgba(255, 255, 255, 0.001)"
                strokeDasharray={`${percentage} ${100 - percentage}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
                tabIndex={0}
                role="button"
                aria-label={`${item.name}: ${currency.format(item.amount)}`}
                onMouseEnter={() => setActiveCategory(index)}
                onMouseLeave={() => setActiveCategory(null)}
                onFocus={() => setActiveCategory(index)}
                onBlur={() => setActiveCategory(null)}
              />
            ))}
          </svg>
          <div
            className={`donut__highlight ${selectedSegment ? 'is-visible' : ''}`}
            style={{ background: highlightGradient }}
            aria-hidden="true"
          />
          <div className="donut__center"><span>Total</span><strong>{compactCurrency.format(total)}</strong></div>
          {selectedSegment && (
            <div className="chart-tooltip chart-tooltip--donut" role="tooltip" style={tooltipPosition}>
              <strong>{selectedSegment.item.name}</strong>
              <span>{currency.format(selectedSegment.item.amount)}</span>
              <small>{Math.round(selectedSegment.percentage)}% das saídas</small>
            </div>
          )}
        </div>
      </div>
      <div className="category-legend">
        {overview.categoryBreakdown.map((item, index) => (
          <button
            type="button"
            key={item.name}
            onMouseEnter={() => setActiveCategory(index)}
            onFocus={() => setActiveCategory(index)}
            onBlur={() => setActiveCategory(null)}
            onClick={() => setActiveCategory((current) => current === index ? null : index)}
          >
            <span><i style={{ background: item.color }} />{item.name}</span><strong>{currency.format(item.amount)}</strong>
          </button>
        ))}
      </div>
    </div>
  );
};

const TransactionRow = ({ item, onEdit }: { item: Transaction; onEdit: (item: Transaction) => void }) => {
  const isIncome = item.kind === 'income';
  return (
    <button type="button" className="mini-transaction" onClick={() => onEdit(item)} aria-label={`Editar ${item.description}`}>
      <div className="category-dot" style={{ background: item.categoryColor ?? 'var(--text-muted)' }}>
        {isIncome ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
      </div>
      <div className="mini-transaction__copy">
        <strong>{item.description}</strong>
        <span>{item.categoryName ?? 'Sem categoria'} · {formatDate(item.dueDate)}</span>
      </div>
      <strong className={isIncome ? 'money-positive' : 'money-negative'}>
        {isIncome ? '+' : '−'} {currency.format(item.actualAmount ?? item.plannedAmount)}
      </strong>
    </button>
  );
};

export const Dashboard = ({
  overview,
  loading,
  onAddTransaction,
  onNavigate,
  onEditTransaction,
  onSettleTransaction,
}: {
  overview: Overview | null;
  loading: boolean;
  onAddTransaction: () => void;
  onNavigate: (view: string) => void;
  onEditTransaction: (item: Transaction) => void;
  onSettleTransaction: (item: Transaction) => Promise<boolean>;
}) => {
  const [settlingId, setSettlingId] = useState('');
  if (loading || !overview) {
    return <div className="dashboard-grid"><Skeleton className="skeleton--hero" /><Skeleton className="skeleton--hero" /><Skeleton className="skeleton--panel" /><Skeleton className="skeleton--panel" /></div>;
  }

  const { summary } = overview;
  const totalCategories = overview.categoryBreakdown.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="dashboard">
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
            <SpendingChart overview={overview} total={totalCategories} />
          ) : <EmptyState icon={<CircleDollarSign />} title="Tudo tranquilo por aqui" description="As categorias aparecem quando você adiciona suas saídas." />}
        </section>

        <section className="panel">
          <header className="panel__header">
            <div><span className="eyebrow">A pagar no mês</span><h3>Contas a caminho</h3></div>
            <button className="text-button" onClick={() => onNavigate('transactions')}>Ver todas <ChevronRight size={16} /></button>
          </header>
          <div className="upcoming-list">
            {overview.upcoming.length ? overview.upcoming.map((item) => (
              <div className="upcoming-item" key={item.id}>
                <button type="button" className="upcoming-item__open" onClick={() => onEditTransaction(item)} aria-label={`Editar ${item.description}`}>
                  <span className="date-badge"><strong>{formatDate(item.dueDate, 'dd')}</strong><small>{formatDate(item.dueDate, 'MMM')}</small></span>
                  <span className="upcoming-item__copy"><strong>{item.description}</strong><small>{item.categoryName ?? 'Sem categoria'}</small></span>
                  <strong>{currency.format(item.plannedAmount)}</strong>
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--success upcoming-item__check"
                  title="Marcar como paga"
                  aria-label={`Marcar ${item.description} como paga`}
                  disabled={settlingId === item.id}
                  onClick={async () => {
                    setSettlingId(item.id);
                    try { await onSettleTransaction(item); } finally { setSettlingId(''); }
                  }}
                >
                  <Check size={17} />
                </button>
              </div>
            )) : <EmptyState icon={<CalendarClock />} title="Nada em aberto neste mês" description="As saídas ainda não pagas deste mês aparecem aqui." />}
          </div>
        </section>

        <section className="panel">
          <header className="panel__header">
            <div><span className="eyebrow">Últimos movimentos</span><h3>Atividade do mês</h3></div>
            <button className="text-button" onClick={() => onNavigate('transactions')}>Abrir lista <ChevronRight size={16} /></button>
          </header>
          <div className="mini-list">
            {overview.recent.length ? overview.recent.map((item) => <TransactionRow key={item.id} item={item} onEdit={onEditTransaction} />) : <EmptyState icon={<ReceiptText />} title="Seu mês começa aqui" description="Adicione a primeira entrada ou saída para acompanhar o movimento." action={<button className="button button--soft" onClick={onAddTransaction}><Plus size={16} /> Adicionar</button>} />}
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
                <button type="button" className="goal-mini" key={goal.id} onClick={() => onNavigate('goals')} aria-label={`Abrir objetivo ${goal.name}`}>
                  <div className="goal-mini__icon"><Target size={20} /></div>
                  <div className="goal-mini__copy"><strong>{goal.name}</strong><span>{currency.format(goal.savedAmount)} de {currency.format(goal.targetAmount)}</span><ProgressBar value={goal.progress} /></div>
                  <strong>{Math.round(goal.progress * 100)}%</strong>
                </button>
              ))}
            </div>
          ) : <EmptyState icon={<PiggyBank />} title="Um sonho cabe aqui" description="Crie um objetivo para acompanhar quanto já guardou e quanto ainda falta." action={<button className="button button--soft" onClick={() => onNavigate('goals')}><Plus size={16} /> Criar objetivo</button>} />}
        </section>
      </div>
    </div>
  );
};
