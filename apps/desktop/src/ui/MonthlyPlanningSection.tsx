import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { safetyMarginToCents, type MonthlyPlanning } from '@lionpocket/core';
import { Modal, MoneyField } from './components';
import { currency, monthLabel } from './format';

export function MonthlyPlanningSection({ month, refreshKey, onChanged, notify }: {
  month: string; refreshKey: number; onChanged: () => void; notify: (message: string) => void;
}) {
  const [planning, setPlanning] = useState<MonthlyPlanning | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    window.lionPocket.getMonthlyPlanning(month).then(value => {
      if (active) setPlanning(value);
    }).catch(() => { if (active) setError('Não foi possível carregar o planejamento.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month, refreshKey]);
  const save = async (cents: number) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await window.lionPocket.saveMonthlyPlanning({ month, safetyMarginCents: cents });
      setPlanning({ month, safetyMarginCents: cents });
      setEditing(false);
      notify(cents ? 'Margem de segurança salva.' : 'Margem de segurança removida.');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a margem.');
    } finally { pending.current = false; setBusy(false); }
  };
  const cents = planning?.safetyMarginCents ?? 0;
  return <>
    <section className="panel monthly-planning" aria-label="Planejamento do mês">
      <div className="monthly-planning__copy">
        <ShieldCheck size={22} aria-hidden="true" />
        <div><small>Planejamento do mês · {monthLabel(month)}</small><h2>Margem de segurança</h2>
          <p>Reserve uma parte do saldo para imprevistos. Esse valor não cria nenhuma despesa.</p></div>
      </div>
      <div className="monthly-planning__action">
        {!loading && cents > 0 && <strong>{currency.format(cents / 100)}</strong>}
        <button className="button button--soft" disabled={loading || busy || Boolean(error)} onClick={() => {
          setAmount(cents ? String(cents / 100) : ''); setError(''); setEditing(true);
        }}>{cents > 0 ? 'Editar' : 'Definir margem de segurança'}</button>
      </div>
      {error && !editing && <div><p className="field__error" role="alert">{error}</p><button className="button button--ghost" onClick={onChanged}>Tentar novamente</button></div>}
    </section>
    {editing && <Modal title="Margem de segurança" description={monthLabel(month)} onClose={() => setEditing(false)} closeDisabled={busy}>
      <form className="form-grid" onSubmit={event => {
        event.preventDefault();
        try { void save(safetyMarginToCents(Number(amount))); }
        catch (cause) { setError((cause as Error).message); }
      }}>
        <p className="form-grid__full">Proteja uma parte do saldo projetado de {monthLabel(month)}. A margem vale somente para este mês.</p>
        <MoneyField className="form-grid__full" label="Margem de segurança" required value={amount} onChange={setAmount} />
        {error && <p className="field__error form-grid__full" role="alert">{error}</p>}
        <div className="modal__actions form-grid__full">
          {cents > 0 && <button type="button" className="button button--ghost" disabled={busy} onClick={() => void save(0)}>Remover margem</button>}
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => setEditing(false)}>Cancelar</button>
          <button className="button button--primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
