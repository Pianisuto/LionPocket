import { useEffect, useMemo, useState } from 'react';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import type { InstallmentPurchase } from '../../shared/types';
import { EmptyState, ProgressBar } from '../components';
import { currency, formatDate } from '../format';

export const Installments = ({ refreshKey, onAdd, onChanged, notify }: {
  refreshKey: number;
  onAdd: () => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<InstallmentPurchase[]>([]);
  useEffect(() => { window.lionPocket.listInstallmentPurchases().then(setItems); }, [refreshKey]);
  const openTotal = useMemo(() => items.reduce((sum, item) => sum + (item.totalInstallments - item.paidInstallments) * item.installmentAmount, 0), [items]);
  const remove = async (item: InstallmentPurchase) => {
    if (!window.confirm(`Excluir “${item.description}” e as parcelas ainda não pagas?`)) return;
    await window.lionPocket.deleteInstallmentPurchase(item.id);
    notify('Compra parcelada removida. As parcelas pagas foram preservadas.');
    onChanged();
  };
  return (
    <section className="page-section">
      <div className="feature-banner feature-banner--installments">
        <div className="feature-banner__icon"><CreditCard size={25} /></div>
        <div><span>Compromissos futuros</span><h3>{currency.format(openTotal)} ainda distribuídos em parcelas</h3><p>Uma compra vira vários meses automaticamente, sem lançamento duplicado.</p></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Nova compra parcelada</button>
      </div>
      <div className="panel installments-panel">
        {items.length ? <div className="installment-list">{items.map((item) => {
          const progress = item.totalInstallments ? item.paidInstallments / item.totalInstallments : 0;
          return <article className="installment-row" key={item.id}>
            <div className="installment-row__icon"><CreditCard size={20} /></div>
            <div className="installment-row__main"><div><strong>{item.description}</strong><span>{item.categoryName ?? 'Sem categoria'} · {item.cardName ?? 'Cartão não informado'}</span></div><ProgressBar value={progress} color="var(--violet)" /><small>{item.paidInstallments} de {item.totalInstallments} parcelas pagas</small></div>
            <div className="installment-row__value"><strong>{currency.format(item.installmentAmount)}</strong><span>por parcela</span></div>
            <div className="installment-row__date"><span>Primeira parcela</span><strong>{formatDate(item.firstDueDate, 'dd/MM/yyyy')}</strong></div>
            <button className="icon-button icon-button--danger" onClick={() => remove(item)} title="Excluir"><Trash2 size={17} /></button>
          </article>;
        })}</div> : <EmptyState icon={<CreditCard />} title="Nenhuma compra parcelada" description="Cadastre uma compra e todas as parcelas serão organizadas para você." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Criar parcelas</button>} />}
      </div>
    </section>
  );
};

