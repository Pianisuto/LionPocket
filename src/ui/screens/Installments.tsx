import { useEffect, useMemo, useState } from 'react';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import type { InstallmentPurchase } from '../../shared/types';
import { EmptyState, ProgressBar } from '../components';
import { currency, formatDate, monthLabel, statusLabel } from '../format';

export const Installments = ({ month, refreshKey, onAdd, onChanged, notify }: {
  month: string;
  refreshKey: number;
  onAdd: () => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<InstallmentPurchase[]>([]);
  useEffect(() => { window.lionPocket.listInstallmentPurchases(month).then(setItems); }, [month, refreshKey]);
  const monthTotal = useMemo(() => items.reduce((sum, item) => sum + item.installmentAmount, 0), [items]);
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
        <div><span>{monthLabel(month)}</span><h3>{currency.format(monthTotal)} em parcelas neste mês</h3><p>{items.length === 1 ? 'Uma compra parcelada aparece neste período.' : `${items.length} compras parceladas aparecem neste período.`}</p></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Nova compra parcelada</button>
      </div>
      <div className="panel installments-panel">
        {items.length ? <div className="installment-list">{items.map((item) => {
          const progress = item.totalInstallments ? item.viewedInstallment / item.totalInstallments : 0;
          const remainingAfterMonth = Math.max(0, item.totalInstallments - item.viewedInstallment);
          const progressLabel = remainingAfterMonth === 0
            ? 'Fim do parcelamento neste mês'
            : `${remainingAfterMonth} ${remainingAfterMonth === 1 ? 'parcela restante' : 'parcelas restantes'} depois deste mês`;
          return <article className="installment-row" key={item.id}>
            <div className="installment-row__icon"><CreditCard size={20} /></div>
            <div className="installment-row__main"><div><strong>{item.description}</strong><span>{item.categoryName ?? 'Sem categoria'} · {item.cardName ?? 'Cartão não informado'}</span></div><ProgressBar value={progress} color="var(--violet)" /><small>{progressLabel}</small></div>
            <div className="installment-row__value"><strong>{currency.format(item.installmentAmount)}</strong><span>por parcela</span></div>
            <div className="installment-row__date"><span>Parcela {item.viewedInstallment} de {item.totalInstallments} · {statusLabel(item.viewedStatus)}</span><strong>{formatDate(item.viewedDueDate, 'dd/MM/yyyy')}</strong></div>
            <button className="icon-button icon-button--danger" onClick={() => remove(item)} title="Excluir"><Trash2 size={17} /></button>
          </article>;
        })}</div> : <EmptyState icon={<CreditCard />} title={`Nenhuma parcela em ${monthLabel(month)}`} description="Mude o mês ou cadastre uma nova compra parcelada." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Criar parcelas</button>} />}
      </div>
    </section>
  );
};
