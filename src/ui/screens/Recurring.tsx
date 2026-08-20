import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarSync, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import type { RecurringExpense } from '../../shared/types';
import { ConfirmDialog, EmptyState } from '../components';
import { currency, formatDate } from '../format';

const intervalLabel = (item: RecurringExpense) => {
  if (item.frequency === 'once') return `Não recorrente · ${formatDate(item.startDate, 'dd/MM/yyyy')}`;
  if (item.frequency === 'weekly') return `Semanal · desde ${formatDate(item.startDate, 'dd/MM/yyyy')}`;
  if (item.frequency === 'manual') {
    const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const selected = item.manualMonths.map((month) => monthNames[Number(month) - 1]).filter(Boolean);
    return `Manual · ${selected.join(', ')}`;
  }
  if (item.frequency === 'custom') {
    const units = {
      days: item.intervalCount === 1 ? 'dia' : 'dias',
      weeks: item.intervalCount === 1 ? 'semana' : 'semanas',
      months: item.intervalCount === 1 ? 'mês' : 'meses',
      years: item.intervalCount === 1 ? 'ano' : 'anos',
    };
    return `A cada ${item.intervalCount} ${units[item.intervalUnit]}${item.anchorToActual ? ' · acompanha a data efetiva' : ''}`;
  }
  return item.cardId && item.chargeDay
    ? `Mensal · cobra dia ${item.chargeDay} no ${item.cardName ?? 'cartão'} · fatura vence dia ${item.dueDay}`
    : `Mensal · ${item.kind === 'income' ? 'recebe dia' : 'vence dia'} ${item.dueDay}`;
};

const amountSuffix = (item: RecurringExpense) => {
  if (item.frequency === 'monthly') return '/mês';
  if (item.frequency === 'weekly') return '/semana';
  if (item.frequency === 'custom') return '/ocorrência';
  return '';
};

export const Recurring = ({ refreshKey, onAdd, onEdit, onChanged, notify }: {
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: RecurringExpense) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<RecurringExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<RecurringExpense | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    setLoading(true);
    window.lionPocket.listRecurringExpenses().then(setItems).finally(() => setLoading(false));
  }, [refreshKey]);
  const totals = useMemo(() => items.filter((item) => item.active).reduce((result, item) => {
    result[item.kind] += item.plannedAmount;
    return result;
  }, { income: 0, expense: 0 }), [items]);
  const toggle = async (item: RecurringExpense) => {
    await window.lionPocket.saveRecurringExpense({ ...item, active: !item.active });
    notify(item.active ? 'Recorrência pausada.' : 'Recorrência ativada.');
    onChanged();
  };
  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await window.lionPocket.deleteRecurringExpense(pendingDelete.id);
      setPendingDelete(null);
      notify('Recorrência excluída.');
      onChanged();
    } catch {
      notify('Não foi possível excluir a recorrência.');
    } finally {
      setDeleting(false);
    }
  };
  const groups = [
    { kind: 'income' as const, label: 'Entradas recorrentes', items: items.filter((item) => item.kind === 'income') },
    { kind: 'expense' as const, label: 'Saídas recorrentes', items: items.filter((item) => item.kind === 'expense') },
  ];
  const renderCard = (item: RecurringExpense) => (
    <article className={`item-card ${!item.active ? 'item-card--disabled' : ''}`} key={item.id}>
      <div className="item-card__header">
        <div className={`item-card__icon ${item.kind === 'income' ? 'item-card__icon--income' : ''}`}>{item.kind === 'income' ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}</div>
        <span className={`status-pill ${item.active ? 'status-pill--received' : 'status-pill--cancelled'}`}>{item.active ? 'Ativa' : 'Pausada'}</span>
      </div>
      <h3>{item.description}</h3>
      <p>{item.categoryName ?? 'Sem categoria'} · {intervalLabel(item)}</p>
      <strong className={`item-card__amount ${item.kind === 'income' ? 'money-positive' : ''}`}>{item.kind === 'income' ? '+' : '−'} {currency.format(item.plannedAmount)}{amountSuffix(item) && <small>{amountSuffix(item)}</small>}</strong>
      <div className="item-card__footer"><span>{item.paymentMethodName ?? (item.kind === 'income' ? 'Recebimento não informado' : 'Pagamento não informado')}</span><div><button className="icon-button" onClick={() => toggle(item)} title={item.active ? 'Pausar' : 'Ativar'}><Power size={16} /></button><button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button><button className="icon-button icon-button--danger" onClick={() => setPendingDelete(item)} title="Excluir"><Trash2 size={16} /></button></div></div>
    </article>
  );
  return (
    <section className="page-section">
      <div className="feature-banner feature-banner--recurring">
        <div className="feature-banner__icon"><CalendarSync size={25} /></div>
        <div><span>Previsibilidade</span><h3 className="recurring-summary"><b><data className="money-positive" value={totals.income}>{currency.format(totals.income)}</data> em entradas</b><b><data className="money-negative" value={totals.expense}>{currency.format(totals.expense)}</data> em saídas</b></h3><p>Organize frequências fixas, flexíveis ou manuais e ajuste cada ocorrência quando precisar.</p></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Nova recorrência</button>
      </div>
      {!loading && items.length > 0 && <div className="recurring-groups">
        {groups.map((group) => group.items.length > 0 && (
          <section className="recurring-group" key={group.kind}>
            <header className={`recurring-group__header recurring-group__header--${group.kind}`}>
              {group.kind === 'income' ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
              <h2>{group.label}</h2>
              <span>{group.items.length}</span>
            </header>
            <div className="card-grid card-grid--three">{group.items.map(renderCard)}</div>
          </section>
        ))}
      </div>}
      {!loading && items.length === 0 && <div className="panel"><EmptyState icon={<CalendarSync />} title="Cadastre o que se repete" description="Use ciclos semanais, mensais, personalizados ou manuais para planejar entradas e saídas." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Nova recorrência</button>} /></div>}
      {pendingDelete && <ConfirmDialog title="Excluir recorrência?" itemName={pendingDelete.description} description="Os lançamentos anteriores serão preservados, mas novos meses deixarão de ser gerados." confirmLabel="Excluir recorrência" loading={deleting} onCancel={() => setPendingDelete(null)} onConfirm={remove} />}
    </section>
  );
};
