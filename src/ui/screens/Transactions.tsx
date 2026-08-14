import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, CheckCheck, History, Pencil, Plus, ReceiptText, Trash2 } from 'lucide-react';
import type { Transaction, TransactionFilters } from '../../shared/types';
import { EmptyState, SearchField, SelectControl } from '../components';
import { currency, currentMonthIso, formatDate, monthLabel, statusLabel } from '../format';

export const Transactions = ({
  month,
  refreshKey,
  onAdd,
  onEdit,
  onChanged,
  notify,
}: {
  month: string;
  refreshKey: number;
  onAdd: () => void;
  onEdit: (item: Transaction) => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) => {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<NonNullable<TransactionFilters['kind']>>('all');
  const [status, setStatus] = useState<NonNullable<TransactionFilters['status']>>('all');

  useEffect(() => {
    setLoading(true);
    window.lionPocket.listTransactions({ month, search, kind, status }).then(setItems).finally(() => setLoading(false));
  }, [month, search, kind, status, refreshKey]);

  const totals = useMemo(() => items.reduce((result, item) => {
    if (item.status === 'cancelled') return result;
    if (item.kind === 'income') result.income += item.actualAmount ?? item.plannedAmount;
    else result.expense += item.actualAmount ?? item.plannedAmount;
    return result;
  }, { income: 0, expense: 0 }), [items]);

  // O mês já virou: o que ficou como "planejado" quase sempre é só um registro
  // que faltou marcar, e dá para resolver tudo de uma vez.
  const closedMonth = month < currentMonthIso();
  const pending = useMemo(() => items.filter((item) => item.status === 'planned'), [items]);
  const pendingTotal = useMemo(
    () => pending.reduce((sum, item) => sum + item.plannedAmount, 0),
    [pending],
  );

  const settle = async (item: Transaction) => {
    await window.lionPocket.settleTransaction(item.id);
    notify(item.kind === 'income' ? 'Entrada marcada como recebida.' : 'Conta marcada como paga.');
    onChanged();
  };

  const settleAllPending = async () => {
    const question = pending.length === 1
      ? `Concluir “${pending[0].description}” usando o valor planejado como valor real?`
      : `Concluir os ${pending.length} lançamentos pendentes de ${monthLabel(month)} usando o valor planejado como valor real?`;
    if (!window.confirm(question)) return;
    const settled = await window.lionPocket.settleTransactions(pending.map((item) => item.id));
    notify(settled === 1 ? 'Lançamento concluído.' : `${settled} lançamentos concluídos.`);
    onChanged();
  };

  const remove = async (item: Transaction) => {
    if (!window.confirm(`Excluir “${item.description}”?`)) return;
    await window.lionPocket.deleteTransaction(item.id);
    notify('Lançamento excluído.');
    onChanged();
  };

  return (
    <section className="page-section">
      {closedMonth && pending.length > 0 && !loading && (
        <div className="feature-banner feature-banner--backfill">
          <div className="feature-banner__icon"><History size={25} /></div>
          <div>
            <span>Mês já encerrado</span>
            <h3>{pending.length === 1 ? '1 lançamento ainda em aberto' : `${pending.length} lançamentos ainda em aberto`}</h3>
            <p>{monthLabel(month)} já passou. Some {currency.format(pendingTotal)} e provavelmente já aconteceu — dá para concluir tudo de uma vez.</p>
          </div>
          <button className="button button--primary" onClick={settleAllPending}>
            <CheckCheck size={18} /> Concluir pendentes
          </button>
        </div>
      )}

      <div className="summary-strip">
        <div><span>Entradas na lista</span><strong className="money-positive">{currency.format(totals.income)}</strong></div>
        <div><span>Saídas na lista</span><strong className="money-negative">{currency.format(totals.expense)}</strong></div>
        <div><span>Diferença</span><strong>{currency.format(totals.income - totals.expense)}</strong></div>
      </div>

      <div className="toolbar">
        <SearchField value={search} onChange={setSearch} placeholder="Buscar descrição ou categoria" />
        <SelectControl className="filter-select" ariaLabel="Filtrar por tipo" value={kind} onChange={(value) => setKind(value as NonNullable<TransactionFilters['kind']>)} options={[
          { value: 'all', label: 'Entradas e saídas' },
          { value: 'income', label: 'Só entradas' },
          { value: 'expense', label: 'Só saídas' },
        ]} />
        <SelectControl className="filter-select" ariaLabel="Filtrar por situação" value={status} onChange={(value) => setStatus(value as NonNullable<TransactionFilters['status']>)} options={[
          { value: 'all', label: 'Todas as situações' },
          { value: 'planned', label: 'Planejado' },
          { value: 'paid', label: 'Pago' },
          { value: 'received', label: 'Recebido' },
          { value: 'cancelled', label: 'Cancelado' },
        ]} />
        <button className="button button--primary" onClick={onAdd}><Plus size={18} /> Novo lançamento</button>
      </div>

      <div className="table-card">
        <div className="data-table data-table--transactions">
          <div className="data-table__header"><span>Data</span><span>Lançamento</span><span>Categoria</span><span>Situação</span><span>Valor</span><span /></div>
          {loading ? <div className="table-loading">Carregando seus lançamentos…</div> : items.map((item) => (
            <div className={`data-table__row ${item.status === 'cancelled' ? 'is-muted' : ''}`} key={item.id}>
              <span className="date-cell"><strong>{formatDate(item.dueDate, 'dd')}</strong><small>{formatDate(item.dueDate, 'MMM')}</small></span>
              <span className="transaction-name">
                <i style={{ background: item.categoryColor ?? 'var(--text-muted)' }}>{item.kind === 'income' ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</i>
                <span><strong>{item.description}</strong><small>{item.installmentNumber ? `${item.installmentNumber} de ${item.installmentTotal} · ` : ''}{item.paymentMethodName ?? item.cardName ?? (item.kind === 'income' ? 'Entrada' : 'Saída')}</small></span>
              </span>
              <span>{item.categoryName ?? 'Sem categoria'}</span>
              <span><i className={`status-pill status-pill--${item.status}`}>{statusLabel(item.status)}</i></span>
              <span className={item.kind === 'income' ? 'money-positive' : ''}><strong>{item.kind === 'income' ? '+' : '−'} {currency.format(item.actualAmount ?? item.plannedAmount)}</strong>{item.actualAmount !== null && item.actualAmount !== item.plannedAmount && <small>Previsto {currency.format(item.plannedAmount)}</small>}</span>
              <span className="row-actions">
                {item.status === 'planned' && <button className="icon-button icon-button--success" onClick={() => settle(item)} title={item.kind === 'income' ? 'Marcar como recebida' : 'Marcar como paga'}><Check size={17} /></button>}
                <button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button>
                <button className="icon-button icon-button--danger" onClick={() => remove(item)} title="Excluir"><Trash2 size={16} /></button>
              </span>
            </div>
          ))}
        </div>
        {!loading && items.length === 0 && <EmptyState icon={<ReceiptText />} title="Nenhum lançamento encontrado" description={search ? 'Tente buscar por outro termo ou mudar os filtros.' : 'Adicione a primeira entrada ou saída deste mês.'} action={!search && <button className="button button--soft" onClick={onAdd}><Plus size={16} /> Adicionar lançamento</button>} />}
      </div>
    </section>
  );
};
