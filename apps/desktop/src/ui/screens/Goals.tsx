import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ExternalLink, Pencil, PiggyBank, Plus, Target, Trash2 } from 'lucide-react';
import { goalReinforcementAction, goalReinforcementNote, goalReinforcementPlan } from '@lionpocket/core';
import type { Goal, GoalMonthlyReinforcement } from '@lionpocket/core/types';
import { ConfirmDialog, EmptyState, ProgressBar } from '../components';
import { currency, formatDate, monthLabel, priorityLabel, statusLabel } from '../format';
import { GoalReinforcementEditor } from '../GoalReinforcementEditor';

export const Goals = ({ month, refreshKey, onAdd, onEdit, onChanged, notify }: {
  month: string;
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: Goal) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<Goal[]>([]);
  const [reinforcements, setReinforcements] = useState<GoalMonthlyReinforcement[]>([]);
  const [planning, setPlanning] = useState<Goal | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { window.lionPocket.listGoals().then(setItems); }, [refreshKey]);
  useEffect(() => {
    let active = true;
    window.lionPocket.listGoalReinforcements(month).then((value) => { if (active) setReinforcements(value); }).catch(() => { if (active) setReinforcements([]); });
    return () => { active = false; };
  }, [month, refreshKey]);
  const plan = useMemo(() => goalReinforcementPlan(items, reinforcements, month), [items, reinforcements, month]);
  const planFor = (goal: Goal) => plan.items.find((item) => item.goalId === goal.id);
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
        <div><span className="eyebrow">Sonhos com plano</span><h2>{currency.format(totals.saved)} guardados</h2><p>de {currency.format(totals.target)} em objetivos ativos</p>
          <p className="goals-heading__plan">Planejado para objetivos em {monthLabel(month)}: <strong>{currency.format(plan.totalCents / 100)}</strong></p></div>
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
            {(() => {
              const item = planFor(goal);
              const action = item && goalReinforcementAction(item);
              if (!item || !action) return null;
              const note = goalReinforcementNote(item);
              return <div className="goal-card__plan" title={note ?? undefined}>
                <span>{monthLabel(month)}: {item.amountCents > 0 ? <strong>{currency.format(item.amountCents / 100)}</strong> : 'sem reforço'}{note && <em> · não conta</em>}</span>
                <button className="text-button" onClick={() => setPlanning(goal)}>{{ define: 'Definir reforço', edit: 'Editar reforço', remove: 'Remover reforço' }[action]}</button>
              </div>;
            })()}
            <footer>{goal.link ? <button className="text-button" onClick={() => window.lionPocket.openExternal(goal.link)}>Abrir link <ExternalLink size={14} /></button> : <span />}
              <div><button className="icon-button" onClick={() => onEdit(goal)} title="Editar"><Pencil size={16} /></button><button className="icon-button icon-button--danger" onClick={() => setPendingDelete(goal)} title="Excluir"><Trash2 size={16} /></button></div>
            </footer>
          </article>
        ))}
      </div>
      {items.length === 0 && <div className="panel"><EmptyState icon={<Target />} title="Dê um nome ao próximo passo" description="Pode ser uma reserva, uma ferramenta, uma viagem ou qualquer coisa importante para você." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Criar objetivo</button>} /></div>}
      {planning && <GoalReinforcementEditor goal={planning} month={month} amountCents={planFor(planning)?.amountCents ?? 0} onClose={() => setPlanning(null)} onChanged={onChanged} notify={notify} />}
      {pendingDelete && <ConfirmDialog title="Excluir objetivo?" itemName={pendingDelete.name} description="O progresso, os valores registrados e o reforço mensal planejado deste objetivo serão removidos." confirmLabel="Excluir objetivo" loading={deleting} onCancel={() => setPendingDelete(null)} onConfirm={remove} />}
    </section>
  );
};
