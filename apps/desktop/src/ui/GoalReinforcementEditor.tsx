import { useRef, useState } from 'react';
import { goalCountsReinforcement, goalReinforcementToCents, suggestionToReinforcementCents } from '@lionpocket/core';
import type { Goal } from '@lionpocket/core/types';
import { Modal, MoneyField } from './components';
import { currency, monthLabel } from './format';

/** Planning only: nothing here creates a transaction or changes the saved amount. */
export function GoalReinforcementEditor({ goal, month, amountCents, onClose, onChanged, notify }: {
  goal: Goal; month: string; amountCents: number; onClose: () => void;
  onChanged: () => void; notify: (message: string) => void;
}) {
  const [amount, setAmount] = useState(amountCents ? String(amountCents / 100) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const editable = goalCountsReinforcement(goal.status);
  const suggestionCents = suggestionToReinforcementCents(goal.suggestedMonthlyAmount);
  const run = async (action: () => Promise<void>, message: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      notify(message);
      onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o reforço.');
    } finally { pending.current = false; setBusy(false); }
  };
  return <Modal title="Reforço do mês" description={`${goal.name} · ${monthLabel(month)}`} onClose={onClose} closeDisabled={busy}>
    <form className="form-grid" onSubmit={event => {
      event.preventDefault();
      let cents: number;
      try { cents = goalReinforcementToCents(Number(amount)); }
      catch (cause) { setError((cause as Error).message); return; }
      void run(() => window.lionPocket.saveGoalReinforcement({ goalId: goal.id, month, amountCents: cents }),
        cents ? 'Reforço salvo.' : 'Reforço removido.');
    }}>
      <p className="form-grid__full">Quanto você pretende reservar para este objetivo em {monthLabel(month)}. É apenas planejamento: não cria despesa nem altera o valor guardado.</p>
      {editable
        ? <MoneyField className="form-grid__full" label="Reforço do mês" required value={amount} onChange={setAmount} />
        : <p className="form-grid__full"><strong>{currency.format(amountCents / 100)}</strong> · {goal.status === 'paused' ? 'Retome o objetivo para alterar o reforço. Você ainda pode removê-lo.' : 'Este objetivo não aceita novo reforço. Você ainda pode removê-lo.'}</p>}
      {editable && suggestionCents !== null && <div className="form-grid__full goal-reinforcement__suggestion">
        <span>Sugestão: {currency.format(suggestionCents / 100)}/mês</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => setAmount(String(suggestionCents / 100))}>Usar sugestão</button>
      </div>}
      {error && <p className="field__error form-grid__full" role="alert">{error}</p>}
      <div className="modal__actions form-grid__full">
        {amountCents > 0 && <button type="button" className="button button--ghost" disabled={busy}
          onClick={() => void run(() => window.lionPocket.removeGoalReinforcement(goal.id, month), 'Reforço removido.')}>Remover reforço</button>}
        <button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>Cancelar</button>
        {editable && <button className="button button--primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>}
      </div>
    </form>
  </Modal>;
}
