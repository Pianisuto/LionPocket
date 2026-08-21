import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, ChevronUp, CreditCard, GripVertical, History, Pencil, Pin, PinOff, Plus, ReceiptText, Trash2 } from 'lucide-react';
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

export const applyPriorityChange = (
  current: Transaction[],
  item: Transaction,
  pinned: boolean,
  beforeTransactionId: string | null,
) => {
  const movedIds = item.sourceType === 'recurring' && item.sourceId
    ? current
        .filter((candidate) => candidate.sourceType === 'recurring'
          && candidate.sourceId === item.sourceId)
        .map((candidate) => candidate.id)
    : [item.id];
  const movedSet = new Set(movedIds);
  const order = [...current]
    .filter((candidate) => candidate.priorityPosition !== null && !movedSet.has(candidate.id))
    .sort((left, right) => Number(left.priorityPosition) - Number(right.priorityPosition))
    .map((candidate) => candidate.id);
  if (pinned) {
    const anchor = beforeTransactionId ? order.indexOf(beforeTransactionId) : -1;
    order.splice(anchor >= 0 ? anchor : order.length, 0, ...movedIds);
  }
  const positions = new Map(order.map((id, position) => [id, position]));
  return current.map((candidate) => ({
    ...candidate,
    priorityPosition: positions.get(candidate.id) ?? null,
  }));
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
  const [dragged, setDragged] = useState<{ id: string; pinned: boolean } | null>(null);
  const draggedRef = useRef<{ id: string; pinned: boolean } | null>(null);
  const pointerDragRef = useRef<{
    id: string;
    pinned: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const pointerDropRef = useRef<{ type: 'priority'; beforeId: string | null } | { type: 'regular' } | null>(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const priorityQueueRef = useRef<Promise<void>>(Promise.resolve());
  const priorityRevisionRef = useRef(0);
  const priorityContextRef = useRef('');
  priorityContextRef.current = [month, search, kind, status, payment, source].join('|');

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
  const priorityItems = useMemo(() => [...items]
    .filter((item) => item.priorityPosition !== null)
    .sort((left, right) => (left.priorityPosition ?? 0) - (right.priorityPosition ?? 0)), [items]);
  const regularItems = useMemo(() => sortedItems
    .filter((item) => item.priorityPosition === null), [sortedItems]);

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

  const clearDrag = () => {
    pointerDragRef.current = null;
    pointerDropRef.current = null;
    draggedRef.current = null;
    setDragged(null);
    setDropBefore(null);
    setDragPoint(null);
  };

  const changePriority = async (
    item: Transaction,
    pinned: boolean,
    beforeTransactionId: string | null = null,
  ) => {
    const revision = ++priorityRevisionRef.current;
    const context = priorityContextRef.current;
    clearDrag();
    setItems((current) => applyPriorityChange(current, item, pinned, beforeTransactionId));

    const operation = priorityQueueRef.current
      .catch(() => undefined)
      .then(() => window.lionPocket.setTransactionPriority({
        month,
        transactionId: item.id,
        pinned,
        beforeTransactionId,
      }));
    priorityQueueRef.current = operation;
    try {
      await operation;
      if (revision === priorityRevisionRef.current && context === priorityContextRef.current) {
        setItems(await window.lionPocket.listTransactions({ month, search, kind, status, payment, source }));
        notify(pinned
          ? item.sourceType === 'recurring'
            ? 'Prioridade salva também para os próximos meses.'
            : 'Lançamento adicionado às prioridades deste mês.'
          : 'Lançamento removido das prioridades.');
      }
    } catch {
      if (revision === priorityRevisionRef.current && context === priorityContextRef.current) {
        window.lionPocket.listTransactions({ month, search, kind, status, payment, source })
          .then(setItems)
          .catch(() => undefined);
        notify('Não foi possível salvar a prioridade.');
      }
    }
  };

  const pointerDropAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const drop = element?.closest<HTMLElement>('[data-priority-drop]');
    if (!drop) return null;
    if (drop.dataset.priorityDrop === 'regular') return { type: 'regular' } as const;
    if (drop.dataset.priorityDrop === 'priority') {
      return { type: 'priority', beforeId: drop.dataset.beforeId || null } as const;
    }
    return null;
  };

  const beginPointerDrag = (event: PointerEvent<HTMLElement>, item: Transaction) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      id: item.id,
      pinned: item.priorityPosition !== null,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const movePointerDrag = (event: PointerEvent<HTMLElement>) => {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!pending.active && Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 5) return;
    event.preventDefault();
    if (!pending.active) {
      pending.active = true;
      const activeDrag = { id: pending.id, pinned: pending.pinned };
      draggedRef.current = activeDrag;
      setDragged(activeDrag);
    }
    setDragPoint({ x: event.clientX, y: event.clientY });
    const drop = pointerDropAt(event.clientX, event.clientY);
    pointerDropRef.current = drop;
    setDropBefore(drop?.type === 'priority' ? drop.beforeId : null);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLElement>) => {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!pending.active) {
      clearDrag();
      return;
    }
    const drop = pointerDropAt(event.clientX, event.clientY) ?? pointerDropRef.current;
    const item = items.find((candidate) => candidate.id === pending.id);
    if (!item || !drop) {
      clearDrag();
      return;
    }
    if (drop.type === 'regular') {
      if (pending.pinned) void changePriority(item, false);
      else clearDrag();
      return;
    }
    if (drop.beforeId !== item.id) void changePriority(item, true, drop.beforeId);
    else clearDrag();
  };

  const renderRow = (item: Transaction, pinned: boolean) => (
    <div
      className={`data-table__row ${pinned ? 'is-priority' : ''} ${dropBefore === item.id ? 'is-drop-before' : ''} ${dragged?.id === item.id ? 'is-dragging' : ''} ${item.status === 'cancelled' ? 'is-muted' : ''} ${item.isOverdue ? 'is-overdue' : ''}`}
      key={item.id}
      data-priority-drop={pinned ? 'priority' : undefined}
      data-before-id={pinned ? item.id : undefined}
    >
      <span
        className="date-cell-container"
        onPointerDown={(event) => beginPointerDrag(event, item)}
        onPointerMove={movePointerDrag}
        onPointerUp={finishPointerDrag}
        onPointerCancel={clearDrag}
        title={pinned ? 'Arraste para reordenar ou devolver à lista' : 'Arraste para Prioridades'}
      >
        <span
          className="priority-drag-handle"
          aria-hidden="true"
        ><GripVertical size={16} /></span>
        <span className="date-cell"><strong>{formatDate(item.dueDate, 'dd')}</strong><small>{formatDate(item.dueDate, 'MMM')}</small></span>
      </span>
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
        <button
          className={`icon-button ${pinned ? 'icon-button--pinned' : ''}`}
          onClick={() => void changePriority(item, !pinned)}
          title={pinned ? 'Remover das prioridades' : 'Adicionar às prioridades'}
        >{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        {item.status === 'planned' && <button className="icon-button icon-button--success" onClick={() => settle(item)} title={item.kind === 'income' ? 'Marcar como recebida' : 'Marcar como paga'}><Check size={17} /></button>}
        <button className="icon-button" onClick={() => onEdit(item)} title="Editar"><Pencil size={16} /></button>
        <button className="icon-button icon-button--danger" onClick={() => setPendingDelete(item)} title="Excluir"><Trash2 size={16} /></button>
      </span>
    </div>
  );

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
          {loading ? <div className="table-loading">Carregando seus lançamentos…</div> : (
            <>
              <div
                className={`priority-zone ${dragged && !dragged.pinned ? 'is-ready' : ''}`}
                data-priority-drop="priority"
              >
                <div
                  className="priority-zone__heading"
                  data-priority-drop="priority"
                  data-before-id={priorityItems[0]?.id ?? ''}
                >
                  <span><Pin size={15} /><strong>Prioridades</strong></span>
                  <small>{priorityItems.length ? 'Arraste para ordenar o que pagar primeiro' : 'Arraste contas para cá para fixá-las no topo'}</small>
                </div>
                {priorityItems.map((item) => renderRow(item, true))}
                {priorityItems.length === 0 && (
                  <div className="priority-zone__empty"><Pin size={18} /> Solte aqui para adicionar às prioridades</div>
                )}
                {priorityItems.length > 0 && dragged && (
                  <div
                    className="priority-zone__end"
                    data-priority-drop="priority"
                  >Soltar no fim das prioridades</div>
                )}
              </div>
              <div
                className={`regular-zone ${dragged?.pinned ? 'is-ready' : ''}`}
                data-priority-drop="regular"
              >
                <div className="regular-zone__heading">
                  <strong>Demais lançamentos</strong>
                  {dragged?.pinned && <small>Solte aqui para despinar</small>}
                </div>
                {regularItems.map((item) => renderRow(item, false))}
              </div>
            </>
          )}
        </div>
        {dragged && dragPoint && (
          <div className="priority-drag-preview" style={{ left: dragPoint.x + 14, top: dragPoint.y + 14 }}>
            <GripVertical size={14} />
            {items.find((item) => item.id === dragged.id)?.description}
          </div>
        )}
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
