import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ExternalLink, Pencil, PiggyBank, Plus, Target, Trash2 } from 'lucide-react';
import type { Goal } from '../../shared/types';
import { ConfirmDialog, EmptyState, ProgressBar } from '../components';
import { currency, formatDate, priorityLabel, statusLabel } from '../format';

export const Goals = ({ refreshKey, onAdd, onEdit, onChanged, notify }: {
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: Goal) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<Goal[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { window.lionPocket.listGoals().then(setItems); }, [refreshKey]);
  const totals = useMemo(() => items.filter((item) => item.status !== 'cancelled').reduce((result, item) => ({ target: result.target + item.targetAmount, saved: result.saved + item.savedAmount }), { target: 0, saved: 0 }), [items]);
  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await window.lionPocket.deleteGoal(pendingDelete.id);
      setPendingDelete(null);
      notify('Objetivo excluído.');
      onChanged();
    } catch {
      notify('Não foi possível excluir o objetivo.');
    } finally {
      setDeleting(false);
    }
  };
  return (
    <section className="page-section">
      <div className="goals-heading">
        <div><span className="eyebrow">Sonhos com plano</span><h2>{currency.format(totals.saved)} guardados</h2><p>de {currency.format(totals.target)} em objetivos ativos</p></div>
        <div className="goals-heading__progress"><div><span>Progresso geral</span><strong>{totals.target ? Math.round((totals.saved / totals.target) * 100) : 0}%</strong></div><ProgressBar value={totals.target ? totals.saved / totals.target : 0} /></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Novo objetivo</button>
      </div>
      <div className="goal-grid">
        {items.map((goal) => (
          <article className="goal-card" key={goal.id}>
            <header><div className="goal-card__icon"><Target size={22} /></div><div className="goal-card__badges"><span className={`priority priority--${goal.priority}`}>{priorityLabel(goal.priority)}</span><span className={`status-pill status-pill--${goal.status}`}>{statusLabel(goal.status)}</span></div></header>
            <h3>{goal.name}</h3><p>{goal.itemModel || goal.categoryName || 'Objetivo pessoal'}</p>
            <div className="goal-card__numbers"><strong>{currency.format(goal.savedAmount)}</strong><span>de {currency.format(goal.targetAmount)}</span></div>
            <ProgressBar value={goal.progress} />
            <div className="goal-card__meta"><span><CalendarDays size={15} /> {goal.dueDate ? formatDate(goal.dueDate, 'dd MMM yyyy') : 'Sem prazo'}</span>{goal.suggestedMonthlyAmount !== null && <span><PiggyBank size={15} /> {currency.format(goal.suggestedMonthlyAmount)}/mês</span>}</div>
            <footer>{goal.link ? <button className="text-button" onClick={() => window.lionPocket.openExternal(goal.link)}>Abrir link <ExternalLink size={14} /></button> : <span />}
              <div><button className="icon-button" onClick={() => onEdit(goal)} title="Editar"><Pencil size={16} /></button><button className="icon-button icon-button--danger" onClick={() => setPendingDelete(goal)} title="Excluir"><Trash2 size={16} /></button></div>
            </footer>
          </article>
        ))}
      </div>
      {items.length === 0 && <div className="panel"><EmptyState icon={<Target />} title="Dê um nome ao próximo passo" description="Pode ser uma reserva, uma ferramenta, uma viagem ou qualquer coisa importante para você." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Criar objetivo</button>} /></div>}
      {pendingDelete && <ConfirmDialog title="Excluir objetivo?" itemName={pendingDelete.name} description="O progresso e os valores registrados neste objetivo serão removidos." confirmLabel="Excluir objetivo" loading={deleting} onCancel={() => setPendingDelete(null)} onConfirm={remove} />}
    </section>
  );
};
