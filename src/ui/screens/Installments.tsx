import { useEffect, useMemo, useState } from 'react';
import { CreditCard, Pencil, Plus, Trash2 } from 'lucide-react';
import type { InstallmentPurchase } from '../../shared/types';
import { ConfirmDialog, EmptyState, ProgressBar } from '../components';
import { currency, formatDate, monthLabel, statusLabel } from '../format';

export const Installments = ({ month, refreshKey, onAdd, onEdit, onChanged, notify }: {
  month: string;
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: InstallmentPurchase) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<InstallmentPurchase[]>([]);
  const [pendingDelete, setPendingDelete] = useState<InstallmentPurchase | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { window.lionPocket.listInstallmentPurchases(month).then(setItems); }, [month, refreshKey]);
  const monthTotal = useMemo(() => items.reduce((sum, item) => sum + item.installmentAmount, 0), [items]);
  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await window.lionPocket.deleteInstallmentPurchase(pendingDelete.id);
      setPendingDelete(null);
      notify('Compra parcelada removida. As parcelas pagas foram preservadas.');
      onChanged();
    } catch {
      notify('Não foi possível excluir a compra parcelada.');
    } finally {
      setDeleting(false);
    }
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
            <div className="installment-row__actions">
              <button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button>
              <button className="icon-button icon-button--danger" onClick={() => setPendingDelete(item)} title="Excluir"><Trash2 size={17} /></button>
            </div>
          </article>;
        })}</div> : <EmptyState icon={<CreditCard />} title={`Nenhuma parcela em ${monthLabel(month)}`} description="Mude o mês ou cadastre uma nova compra parcelada." action={<button className="button button--soft" onClick={onAdd}><Plus size={16} /> Criar parcelas</button>} />}
      </div>
      {pendingDelete && <ConfirmDialog title="Excluir compra parcelada?" itemName={pendingDelete.description} description="As parcelas ainda não pagas serão removidas. As parcelas já concluídas permanecem no histórico." confirmLabel="Excluir compra" loading={deleting} onCancel={() => setPendingDelete(null)} onConfirm={remove} />}
    </section>
  );
};
