import { useEffect, useMemo, useState } from 'react';
import { CalendarSync, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import type { RecurringExpense } from '../../shared/types';
import { EmptyState } from '../components';
import { currency } from '../format';

export const Recurring = ({ refreshKey, onAdd, onEdit, onChanged, notify }: {
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: RecurringExpense) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<RecurringExpense[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    window.lionPocket.listRecurringExpenses().then(setItems).finally(() => setLoading(false));
  }, [refreshKey]);
  const total = useMemo(() => items.filter((item) => item.active).reduce((sum, item) => sum + item.plannedAmount, 0), [items]);
  const toggle = async (item: RecurringExpense) => {
    await window.lionPocket.saveRecurringExpense({ ...item, active: !item.active });
    notify(item.active ? 'Despesa pausada.' : 'Despesa ativada.');
    onChanged();
  };
  const remove = async (item: RecurringExpense) => {
    if (!window.confirm(`Excluir a despesa fixa “${item.description}”? Os meses anteriores serão preservados.`)) return;
    await window.lionPocket.deleteRecurringExpense(item.id);
    notify('Despesa fixa excluída.');
    onChanged();
  };
  return (
    <section className="page-section">
      <div className="feature-banner feature-banner--recurring">
        <div className="feature-banner__icon"><CalendarSync size={25} /></div>
        <div><span>Previsibilidade</span><h3>{currency.format(total)} em despesas fixas ativas</h3><p>Estas contas entram automaticamente em cada mês e podem ser ajustadas depois.</p></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Nova despesa fixa</button>
      </div>
      <div className="card-grid card-grid--three">
        {!loading && items.map((item) => (
          <article className={`item-card ${!item.active ? 'item-card--disabled' : ''}`} key={item.id}>
            <div className="item-card__header">
              <div className="item-card__icon"><CalendarSync size={20} /></div>
              <span className={`status-pill ${item.active ? 'status-pill--received' : 'status-pill--cancelled'}`}>{item.active ? 'Ativa' : 'Pausada'}</span>
            </div>
            <h3>{item.description}</h3>
            <p>{item.categoryName ?? 'Sem categoria'} · vence dia {item.dueDay}</p>
            <strong className="item-card__amount">{currency.format(item.plannedAmount)}<small>/mês</small></strong>
            <div className="item-card__footer"><span>{item.paymentMethodName ?? 'Forma não informada'}</span><div><button className="icon-button" onClick={() => toggle(item)} title={item.active ? 'Pausar' : 'Ativar'}><Power size={16} /></button><button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button><button className="icon-button icon-button--danger" onClick={() => remove(item)} title="Excluir"><Trash2 size={16} /></button></div></div>
          </article>
        ))}
      </div>
      {!loading && items.length === 0 && <div className="panel"><EmptyState icon={<CalendarSync />} title="Cadastre o que se repete" description="Internet, aluguel e assinaturas podem entrar automaticamente todo mês." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Nova despesa fixa</button>} /></div>}
    </section>
  );
};

