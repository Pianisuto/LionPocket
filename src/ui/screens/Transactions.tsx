import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, ChevronUp, CreditCard, History, Pencil, Plus, ReceiptText, Trash2 } from 'lucide-react';
import type { Transaction, TransactionFilters } from '../../shared/types';
import { ConfirmDialog, EmptyState, Modal, SearchField, SelectControl } from '../components';
import { currency, currentMonthIso, formatDate, monthLabel, overdueLabel, statusLabel } from '../format';

type SortKey = 'date' | 'description' | 'category' | 'paymentMethod' | 'card' | 'status' | 'amount';
type SortDirection = 'asc' | 'desc';

const sortLabels: Record<SortKey, string> = {
  date: 'Vencimento',
  description: 'Lançamento',
  category: 'Categoria',
  paymentMethod: 'Pagamento',
  card: 'Cartão',
  status: 'Situação',
  amount: 'Valor',
};

const expenseCountsInMonth = (item: Transaction, month: string) => {
  if (item.kind !== 'expense' || item.status === 'cancelled') return false;
  if (item.status === 'paid') return (item.settledDate ?? item.dueDate).slice(0, 7) === month;
  if (item.status !== 'planned') return item.dueDate.slice(0, 7) === month;
  const dueMonth = item.dueDate.slice(0, 7);
  if (dueMonth === month) return !(item.isOverdue && month < currentMonthIso());
  return item.isOverdue && dueMonth < month;
};

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
  const [payment, setPayment] = useState<NonNullable<TransactionFilters['payment']>>('all');
  const [source, setSource] = useState<NonNullable<TransactionFilters['source']>>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'date', direction: 'asc' });
  const [creditCardExpenses, setCreditCardExpenses] = useState<Transaction[]>([]);
  const [payingCard, setPayingCard] = useState(false);
  const [payCardOpen, setPayCardOpen] = useState(false);
  const [selectedCardKey, setSelectedCardKey] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    window.lionPocket.listTransactions({ month, search, kind, status, payment, source }).then(setItems).finally(() => setLoading(false));
  }, [month, search, kind, status, payment, source, refreshKey]);

  useEffect(() => {
    let active = true;
    window.lionPocket.listTransactions({ month, kind: 'expense', status: 'planned' })
      .then((transactions) => {
        if (!active) return;
        setCreditCardExpenses(transactions.filter((item) =>
          Boolean(item.cardId)
          || item.paymentMethodName?.trim().toLocaleLowerCase('pt-BR') === 'cartão de crédito',
        ));
      })
      .catch(() => {
        if (active) setCreditCardExpenses([]);
      });
    return () => { active = false; };
  }, [month, refreshKey]);

  const totals = useMemo(() => items.reduce((result, item) => {
    if (item.status === 'cancelled') return result;
    if (item.kind === 'income') result.income += item.actualAmount ?? item.plannedAmount;
    else if (expenseCountsInMonth(item, month)) result.expense += item.actualAmount ?? item.plannedAmount;
    return result;
  }, { income: 0, expense: 0 }), [items, month]);

  const sortedItems = useMemo(() => {
    const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
    const textValue = (item: Transaction, key: SortKey) => {
      if (key === 'date') return item.dueDate;
      if (key === 'description') return item.description;
      if (key === 'category') return item.categoryName ?? 'Sem categoria';
      if (key === 'paymentMethod') return item.paymentMethodName ?? 'Não informado';
      if (key === 'card') return item.cardName ?? '';
      return statusLabel(item.status);
    };
    return [...items].sort((left, right) => {
      const comparison = sort.key === 'amount'
        ? (left.actualAmount ?? left.plannedAmount) - (right.actualAmount ?? right.plannedAmount)
        : collator.compare(textValue(left, sort.key), textValue(right, sort.key));
      const directed = sort.direction === 'asc' ? comparison : -comparison;
      return directed || collator.compare(left.description, right.description) || left.id.localeCompare(right.id);
    });
  }, [items, sort]);

  const chooseSort = (key: SortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' });
  };

  const closedMonth = month < currentMonthIso();
  const carriedForward = useMemo(() => items.filter((item) =>
    item.isOverdue && item.dueDate.slice(0, 7) === month && closedMonth), [closedMonth, items, month]);
  const overdueInProjection = useMemo(() => items
    .filter((item) => item.isOverdue && expenseCountsInMonth(item, month))
    .reduce((sum, item) => sum + item.plannedAmount, 0), [items, month]);
  const creditCardGroups = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; dueDate: string; overdue: boolean; items: Transaction[]; total: number }>();
    for (const item of creditCardExpenses) {
      const cardKey = item.cardId ?? item.paymentMethodId ?? 'unassigned';
      const key = `${cardKey}:${item.dueDate}`;
      const current = groups.get(key) ?? {
        key,
        name: `Fatura ${item.cardName ?? 'sem cartão informado'}`,
        dueDate: item.dueDate,
        overdue: item.isOverdue,
        items: [],
        total: 0,
      };
      current.items.push(item);
      current.total += item.plannedAmount;
      groups.set(key, current);
    }
    return [...groups.values()].sort((left, right) => Number(right.overdue) - Number(left.overdue)
      || left.dueDate.localeCompare(right.dueDate)
      || left.name.localeCompare(right.name, 'pt-BR'));
  }, [creditCardExpenses]);
  const selectedCard = creditCardGroups.find((group) => group.key === selectedCardKey) ?? creditCardGroups[0];
  const hasActiveFilters = Boolean(search)
    || kind !== 'all'
    || status !== 'all'
    || payment !== 'all'
    || source !== 'all';

  const settle = async (item: Transaction) => {
    await window.lionPocket.settleTransaction(item.id);
    notify(item.kind === 'income' ? 'Entrada marcada como recebida.' : 'Conta marcada como paga.');
    onChanged();
  };

  const payCreditCard = async () => {
    if (!selectedCard) return;
    setPayingCard(true);
    try {
      const settled = await window.lionPocket.settleTransactions(selectedCard.items.map((item) => item.id));
      notify(settled === 1 ? `1 saída da ${selectedCard.name} marcada como paga.` : `${settled} saídas da ${selectedCard.name} marcadas como pagas.`);
      setPayCardOpen(false);
      onChanged();
    } finally {
      setPayingCard(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await window.lionPocket.deleteTransaction(pendingDelete.id);
      setItems((current) => current.filter((item) => item.id !== pendingDelete.id));
      setPendingDelete(null);
      notify('Lançamento excluído.');
      onChanged();
    } catch {
      notify('Não foi possível excluir o lançamento.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="page-section">
      {carriedForward.length > 0 && !loading && (
        <div className="feature-banner feature-banner--backfill">
          <div className="feature-banner__icon"><History size={25} /></div>
          <div>
            <span>Carregadas adiante</span>
            <h3>{carriedForward.length === 1 ? '1 conta continua em atraso' : `${carriedForward.length} contas continuam em atraso`}</h3>
            <p>Elas permanecem visíveis em {monthLabel(month)} para histórico, mas só entram nas projeções dos meses seguintes até serem pagas.</p>
          </div>
        </div>
      )}

      <div className="summary-strip">
        <div><span>Entradas na lista</span><strong className="money-positive">{currency.format(totals.income)}</strong></div>
        <div><span>Saídas consideradas</span><strong className="money-negative">{currency.format(totals.expense)}</strong>{overdueInProjection > 0 && <small>{currency.format(overdueInProjection)} em atraso</small>}</div>
        <div><span>Diferença</span><strong>{currency.format(totals.income - totals.expense)}</strong></div>
      </div>

      <div className="toolbar">
        <SearchField value={search} onChange={setSearch} placeholder="Buscar lançamento, categoria ou pagamento" />
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
        <SelectControl className="filter-select" ariaLabel="Filtrar por forma de pagamento" value={payment} onChange={(value) => setPayment(value as NonNullable<TransactionFilters['payment']>)} options={[
          { value: 'all', label: 'Todos os pagamentos' },
          { value: 'creditCard', label: 'Cartão de crédito' },
          { value: 'other', label: 'Outras formas' },
        ]} />
        <SelectControl className="filter-select" ariaLabel="Filtrar por origem" value={source} onChange={(value) => setSource(value as NonNullable<TransactionFilters['source']>)} options={[
          { value: 'all', label: 'Todas as origens' },
          { value: 'installment', label: 'Compras parceladas' },
          { value: 'recurring', label: 'Recorrências' },
          { value: 'manual', label: 'Lançamentos avulsos' },
          { value: 'imported', label: 'Dados importados' },
        ]} />
        {creditCardExpenses.length > 0 && (
          <button className="button button--soft" disabled={payingCard} onClick={() => {
            setSelectedCardKey(creditCardGroups[0]?.key ?? '');
            setPayCardOpen(true);
          }} title="Escolher um cartão para pagar neste mês">
            <CreditCard size={18} /> Pagar cartão
          </button>
        )}
      </div>

      <div className="table-card">
        <div className="data-table data-table--transactions">
          <div className="data-table__header" role="row">
            {(Object.keys(sortLabels) as SortKey[]).map((key) => (
              <span role="columnheader" aria-sort={sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} key={key}>
                <button type="button" className={sort.key === key ? 'is-active' : ''} onClick={() => chooseSort(key)}>
                  {sortLabels[key]}
                  {sort.key === key && (sort.direction === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
                </button>
              </span>
            ))}
            <span aria-hidden="true" />
          </div>
          {loading ? <div className="table-loading">Carregando seus lançamentos…</div> : sortedItems.map((item) => (
            <div className={`data-table__row ${item.status === 'cancelled' ? 'is-muted' : ''} ${item.isOverdue ? 'is-overdue' : ''}`} key={item.id}>
              <span className="date-cell"><strong>{formatDate(item.dueDate, 'dd')}</strong><small>{formatDate(item.dueDate, 'MMM')}</small></span>
              <span className="transaction-name">
                <i style={{ background: item.categoryColor ?? 'var(--text-muted)' }}>{item.kind === 'income' ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}</i>
                <span>
                  <strong>{item.description}</strong>
                  {(item.isOverdue || item.purchaseDate || item.installmentNumber || (item.status === 'paid' && item.settledDate && item.settledDate !== item.dueDate)) && (
                    <small>{[
                      item.isOverdue
                        ? item.dueDate.slice(0, 7) === month && closedMonth
                          ? `Carregada adiante · venceu em ${formatDate(item.dueDate, 'dd/MM/yyyy')}`
                          : overdueLabel(item.dueDate)
                        : null,
                      item.status === 'paid' && item.settledDate && item.settledDate !== item.dueDate
                        ? `Pago em ${formatDate(item.settledDate, 'dd/MM/yyyy')}`
                        : null,
                      item.purchaseDate ? `Compra em ${formatDate(item.purchaseDate, 'dd/MM/yyyy')}` : null,
                      item.installmentNumber ? `${item.installmentNumber} de ${item.installmentTotal} parcelas` : null,
                    ].filter(Boolean).join(' · ')}</small>
                  )}
                </span>
              </span>
              <span>{item.categoryName ?? 'Sem categoria'}</span>
              <span>{item.paymentMethodName ?? 'Não informado'}</span>
              <span>{item.cardName ?? '—'}</span>
              <span><i className={`status-pill status-pill--${item.isOverdue ? 'overdue' : item.status}`}>{item.isOverdue ? 'Atrasado' : statusLabel(item.status)}</i></span>
              <span className={item.kind === 'income' ? 'money-positive' : ''}><strong>{item.kind === 'income' ? '+' : '−'} {currency.format(item.actualAmount ?? item.plannedAmount)}</strong>{item.actualAmount !== null && item.actualAmount !== item.plannedAmount && <small>Previsto {currency.format(item.plannedAmount)}</small>}</span>
              <span className="row-actions">
                {item.status === 'planned' && <button className="icon-button icon-button--success" onClick={() => settle(item)} title={item.kind === 'income' ? 'Marcar como recebida' : 'Marcar como paga'}><Check size={17} /></button>}
                <button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button>
                <button className="icon-button icon-button--danger" onClick={() => setPendingDelete(item)} title="Excluir"><Trash2 size={16} /></button>
              </span>
            </div>
          ))}
        </div>
        {!loading && items.length === 0 && <EmptyState icon={<ReceiptText />} title="Nenhum lançamento encontrado" description={hasActiveFilters ? 'Tente buscar por outro termo ou mudar os filtros.' : 'Adicione a primeira entrada ou saída deste mês.'} action={!hasActiveFilters && <button className="button button--soft" onClick={onAdd}><Plus size={16} /> Adicionar lançamento</button>} />}
      </div>

      {payCardOpen && selectedCard && (
        <Modal title="Pagar cartão" description="Escolha uma fatura. Atrasos e faturas atuais ficam separados pelo vencimento." onClose={() => setPayCardOpen(false)}>
          <div className="pay-card-modal__body">
            <div className="pay-card-options" role="radiogroup" aria-label="Cartão a pagar">
              {creditCardGroups.map((group) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={group.key === selectedCard.key}
                  className={group.key === selectedCard.key ? 'is-selected' : ''}
                  key={group.key}
                  onClick={() => setSelectedCardKey(group.key)}
                >
                  <span className="pay-card-options__icon"><CreditCard size={18} /></span>
                  <span className="pay-card-options__copy"><strong>{group.name}</strong><small>{group.overdue ? 'Atrasada' : 'Vence'} em {formatDate(group.dueDate, 'dd/MM/yyyy')} · {group.items.length} {group.items.length === 1 ? 'saída' : 'saídas'}</small></span>
                  <strong className="pay-card-options__value">{currency.format(group.total)}</strong>
                  <span className="pay-card-options__check">{group.key === selectedCard.key && <Check size={15} strokeWidth={2.8} />}</span>
                </button>
              ))}
            </div>
            <div className="modal__actions">
              <button type="button" className="button button--ghost" disabled={payingCard} onClick={() => setPayCardOpen(false)}>Cancelar</button>
              <button type="button" className="button button--primary" disabled={payingCard} onClick={payCreditCard}>{payingCard ? 'Pagando…' : `Pagar ${currency.format(selectedCard.total)}`}</button>
            </div>
          </div>
        </Modal>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Excluir lançamento?"
          itemName={pendingDelete.description}
          description={pendingDelete.sourceType === 'recurring'
            ? 'Somente esta ocorrência será removida. A recorrência continua nos outros meses.'
            : pendingDelete.sourceType === 'installment'
              ? 'Somente esta parcela será removida. A compra e as demais parcelas serão mantidas.'
              : 'O lançamento será removido do seu histórico.'}
          confirmLabel="Excluir lançamento"
          loading={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={remove}
        />
      )}
    </section>
  );
};
