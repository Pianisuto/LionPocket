import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { History, Link2 } from 'lucide-react';
import type {
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchaseInput,
  MoneyKind,
  RecurringExpense,
  RecurringExpenseInput,
  Transaction,
  TransactionInput,
  TransactionStatus,
  TransactionSuggestion,
} from '../shared/types';
import { DateField, Modal, MonthField, SelectField } from './components';
import { cardStatementDueDate, currentMonthIso, currency, dateForMonthDay, formatDate, isPastDate, nextCardDueDate, settlementDateFor, todayIso } from './format';

const moneyValue = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

const settledStatusFor = (kind: MoneyKind): TransactionStatus => (kind === 'income' ? 'received' : 'paid');

const isSettled = (status: TransactionStatus) => status === 'paid' || status === 'received';

/** A situação que combina com a data: o que venceu antes de hoje já aconteceu. */
const statusForDate = (date: string, kind: MoneyKind): TransactionStatus =>
  isPastDate(date) ? settledStatusFor(kind) : 'planned';

export const TransactionForm = ({
  transaction,
  catalogs,
  defaultDate,
  onSave,
  onClose,
}: {
  transaction?: Transaction | null;
  catalogs: Catalogs;
  defaultDate: string;
  onSave: (input: TransactionInput, options?: { keepOpen?: boolean }) => Promise<boolean>;
  onClose: () => void;
}) => {
  const [kind, setKind] = useState<MoneyKind>(transaction?.kind ?? 'expense');
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? '');
  const [plannedAmount, setPlannedAmount] = useState(moneyValue(transaction?.plannedAmount));
  const [actualAmount, setActualAmount] = useState(moneyValue(transaction?.actualAmount));
  const [purchaseDate, setPurchaseDate] = useState(
    transaction ? transaction.purchaseDate ?? '' : todayIso(),
  );
  const [dueDate, setDueDate] = useState(transaction?.dueDate ?? defaultDate);
  const [status, setStatus] = useState<TransactionStatus>(
    transaction?.status ?? statusForDate(transaction?.dueDate ?? defaultDate, transaction?.kind ?? 'expense'),
  );
  // Enquanto ninguém escolher uma situação à mão, ela continua acompanhando a
  // data — mexer no calendário deixa de exigir um segundo ajuste.
  const [statusChosen, setStatusChosen] = useState(Boolean(transaction));
  const [paymentMethodId, setPaymentMethodId] = useState(transaction?.paymentMethodId ?? '');
  const [cardId, setCardId] = useState(transaction?.cardId ?? '');
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  // Planejado e real andam juntos até você digitar um valor real diferente.
  // Na maioria dos lançamentos já acontecidos os dois são o mesmo número.
  const [amountsLinked, setAmountsLinked] = useState(
    !transaction || transaction.actualAmount === null || transaction.actualAmount === transaction.plannedAmount,
  );
  const [suggestions, setSuggestions] = useState<TransactionSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const descriptionId = useId();

  const categories = catalogs.categories.filter((category) => category.kind === kind);
  const creditMethod = useMemo(
    () => catalogs.paymentMethods.find((method) => method.name.toLocaleLowerCase('pt-BR') === 'cartão de crédito'),
    [catalogs.paymentMethods],
  );
  const selectedCard = catalogs.cards.find((item) => item.id === cardId);
  const creditSelected = paymentMethodId === creditMethod?.id || Boolean(cardId);
  const settled = isSettled(status);
  const backfilling = isPastDate(dueDate);

  useEffect(() => {
    const term = description.trim();
    if (transaction || !suggestionsOpen || term.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      window.lionPocket
        .suggestTransactions(kind, term)
        .then((items) => {
          if (active) setSuggestions(items);
        })
        .catch(() => undefined);
    }, 160);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [description, kind, suggestionsOpen, transaction]);

  const applyKind = (next: MoneyKind) => {
    setKind(next);
    setCategoryId('');
    if (next === 'income') {
      setPaymentMethodId('');
      setCardId('');
      setPurchaseDate('');
    }
    if (!statusChosen) setStatus(statusForDate(dueDate, next));
    else if (settled) setStatus(settledStatusFor(next));
  };

  const applyDueDate = (value: string) => {
    setDueDate(value);
    if (statusChosen) return;
    const nextStatus = statusForDate(value, kind);
    setStatus(nextStatus);
    if (amountsLinked) setActualAmount(isSettled(nextStatus) ? plannedAmount : '');
  };

  const applyCard = (nextCardId: string) => {
    setCardId(nextCardId);
    if (!nextCardId) return;
    if (creditMethod) setPaymentMethodId(creditMethod.id);
    const card = catalogs.cards.find((item) => item.id === nextCardId);
    if (!card) return;
    const effectivePurchaseDate = purchaseDate || todayIso();
    if (!purchaseDate) setPurchaseDate(effectivePurchaseDate);
    applyDueDate(card.closingDay === null
      ? nextCardDueDate(effectivePurchaseDate, card.dueDay)
      : cardStatementDueDate(effectivePurchaseDate, card.closingDay, card.dueDay));
  };

  const applyPurchaseDate = (value: string) => {
    setPurchaseDate(value);
    if (!value || !selectedCard || selectedCard.closingDay === null) return;
    applyDueDate(cardStatementDueDate(value, selectedCard.closingDay, selectedCard.dueDay));
  };

  const applyPaymentMethod = (nextMethodId: string) => {
    setPaymentMethodId(nextMethodId);
    if (nextMethodId !== creditMethod?.id) {
      setCardId('');
      return;
    }
    const nextCardId = cardId || catalogs.cards[0]?.id || '';
    if (nextCardId) applyCard(nextCardId);
  };

  const applyStatus = (value: TransactionStatus) => {
    setStatus(value);
    setStatusChosen(true);
    if (!amountsLinked) return;
    setActualAmount(isSettled(value) ? plannedAmount : '');
  };

  const applyPlanned = (value: string) => {
    setPlannedAmount(value);
    if (amountsLinked && settled) setActualAmount(value);
  };

  const applyActual = (value: string) => {
    setActualAmount(value);
    if (plannedAmount === '') {
      setPlannedAmount(value);
      setAmountsLinked(true);
      return;
    }
    setAmountsLinked(value === plannedAmount);
  };

  /** Repete um lançamento antigo: só completa o que ainda está em branco. */
  const applySuggestion = (item: TransactionSuggestion) => {
    setDescription(item.description);
    setSuggestionsOpen(false);
    if (item.categoryId && !categoryId) setCategoryId(item.categoryId);
    if (item.paymentMethodId && !paymentMethodId && kind === 'expense') applyPaymentMethod(item.paymentMethodId);
    if (item.cardId && !cardId && kind === 'expense') applyCard(item.cardId);
    if (item.amount > 0 && plannedAmount === '') {
      const value = String(item.amount);
      setPlannedAmount(value);
      if (amountsLinked && settled) setActualAmount(value);
    }
    descriptionRef.current?.focus();
  };

  /** Limpa só o que muda de um lançamento para o outro. */
  const resetForNext = () => {
    setDescription('');
    setPlannedAmount('');
    setActualAmount('');
    setNotes('');
    setAmountsLinked(true);
    setSuggestionsOpen(false);
    setSuggestions([]);
    descriptionRef.current?.focus();
  };

  const persist = async (keepOpen: boolean) => {
    setSaving(true);
    try {
      const finalStatus = settled ? settledStatusFor(kind) : status;
      const saved = await onSave(
        {
          id: transaction?.id,
          kind,
          description,
          categoryId: categoryId || null,
          plannedAmount: Number(plannedAmount),
          actualAmount: actualAmount === '' ? null : Number(actualAmount),
          purchaseDate: cardId && purchaseDate ? purchaseDate : null,
          dueDate,
          settledDate: isSettled(finalStatus)
            ? transaction?.settledDate ?? settlementDateFor(dueDate)
            : null,
          status: finalStatus,
          paymentMethodId: paymentMethodId || null,
          cardId: cardId || null,
          notes,
        },
        { keepOpen },
      );
      if (saved && keepOpen) {
        setSavedCount((count) => count + 1);
        resetForNext();
      }
    } finally {
      setSaving(false);
    }
  };

  const saveAndContinue = () => {
    if (!formRef.current?.reportValidity()) return;
    void persist(true);
  };

  return (
    <Modal
      title={transaction ? 'Editar lançamento' : 'Novo lançamento'}
      description={backfilling
        ? 'A data já passou, então o lançamento entra como concluído. É só conferir os valores.'
        : 'Registre o planejado agora e confirme o valor real quando acontecer.'}
      onClose={onClose}
      wide
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void persist(false);
        }}
        className="form-grid form-grid--transaction"
      >
        <div className="segmented form-grid__full">
          <button type="button" className={kind === 'expense' ? 'active' : ''} onClick={() => applyKind('expense')}>Saída</button>
          <button type="button" className={kind === 'income' ? 'active' : ''} onClick={() => applyKind('income')}>Entrada</button>
        </div>
        <div className="field form-grid__full field--suggest">
          <span><label htmlFor={descriptionId}>Descrição</label></span>
          <input
            id={descriptionId}
            ref={descriptionRef}
            required
            autoFocus
            autoComplete="off"
            role="combobox"
            aria-expanded={!transaction && suggestionsOpen && suggestions.length > 0}
            aria-autocomplete="list"
            value={description}
            onChange={(event) => { setDescription(event.target.value); setSuggestionsOpen(true); }}
            onFocus={() => setSuggestionsOpen(true)}
            onBlur={() => setSuggestionsOpen(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && suggestionsOpen && suggestions.length) {
                event.preventDefault();
                setSuggestionsOpen(false);
              }
            }}
            placeholder={kind === 'expense' ? 'Ex.: Supermercado' : 'Ex.: Salário'}
          />
          {!transaction && suggestionsOpen && suggestions.length > 0 && (
            <div className="suggest-menu" role="listbox" aria-label="Lançamentos parecidos">
              <span className="suggest-menu__title"><History size={13} /> Você já lançou</span>
              {suggestions.map((item) => (
                <button
                  key={item.description}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="suggest-menu__option"
                  onMouseDown={(event) => { event.preventDefault(); applySuggestion(item); }}
                >
                  <strong>{item.description}</strong>
                  <small>{[item.categoryName ?? 'Sem categoria', item.amount > 0 ? currency.format(item.amount) : null].filter(Boolean).join(' · ')}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[
          { value: '', label: 'Sem categoria' },
          ...categories.map((category) => ({ value: category.id, label: category.name })),
        ]} />
        <label className="field">
          <span>Valor planejado</span>
          <div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={plannedAmount} onChange={(event) => applyPlanned(event.target.value)} /></div>
        </label>

        {kind === 'expense' && (
          <SelectField label="Forma de pagamento" value={paymentMethodId} onChange={applyPaymentMethod} options={[
            { value: '', label: 'Não informada' },
            ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name })),
          ]} />
        )}
        {kind === 'expense' && creditSelected && (
          <SelectField label="Cartão" value={cardId} onChange={applyCard} options={[
            { value: '', label: 'Nenhum' },
            ...catalogs.cards.map((card) => ({ value: card.id, label: `${card.name} · ${card.closingDay === null ? 'sem fechamento' : `fecha ${card.closingDay}`} · vence ${card.dueDay}` })),
          ]} />
        )}

        {cardId && <DateField label="Data da compra" value={purchaseDate} onChange={applyPurchaseDate} required={!transaction || Boolean(transaction.purchaseDate)} />}
        <DateField label={cardId ? 'Vencimento da fatura' : 'Data prevista'} value={dueDate} onChange={applyDueDate} required />
        {cardId && selectedCard && (
          <div className={`card-cycle-note form-grid__full ${selectedCard.closingDay === null || !purchaseDate ? 'card-cycle-note--warning' : ''}`}>
            {selectedCard.closingDay === null
              ? <>Configure o fechamento do <strong>{selectedCard.name}</strong> para o app escolher a fatura automaticamente. O vencimento ainda pode ser ajustado acima.</>
              : !purchaseDate
                ? <>Este é um lançamento antigo sem data da compra. O vencimento foi preservado; ao informar a compra, o app recalcula a fatura.</>
                : <>Compra em <strong>{formatDate(purchaseDate, 'dd/MM/yyyy')}</strong> · fatura com vencimento em <strong>{formatDate(dueDate, 'dd/MM/yyyy')}</strong>. O mês da tela será o mês desse vencimento.</>}
          </div>
        )}

        <SelectField label="Situação" value={status} onChange={(value) => applyStatus(value as TransactionStatus)} options={[
          { value: 'planned', label: 'Planejado' },
          { value: settledStatusFor(kind), label: kind === 'income' ? 'Recebido' : 'Pago' },
          { value: 'cancelled', label: 'Cancelado' },
        ]} />
        <label className="field">
          <span>
            Valor real{' '}
            {settled && amountsLinked
              ? <small className="field__linked"><Link2 size={12} /> igual ao planejado</small>
              : <small>(opcional)</small>}
          </span>
          <div className="money-input"><span>R$</span><input min="0" step="0.01" type="number" value={actualAmount} onChange={(event) => applyActual(event.target.value)} /></div>
        </label>
        <label className="field form-grid__full">
          <span>Observações</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Algo importante sobre este lançamento?" rows={2} />
        </label>
        <div className="modal__actions form-grid__full">
          {savedCount > 0 && <span className="modal__actions-note">{savedCount} {savedCount === 1 ? 'lançamento salvo' : 'lançamentos salvos'} nesta sessão</span>}
          <button type="button" className="button button--ghost" onClick={onClose}>{savedCount > 0 ? 'Concluir' : 'Cancelar'}</button>
          {!transaction && (
            <button type="button" className="button button--soft" disabled={saving} onClick={saveAndContinue}>
              Salvar e adicionar outro
            </button>
          )}
          <button className="button button--primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar lançamento'}</button>
        </div>
      </form>
    </Modal>
  );
};

export const RecurringForm = ({ item, catalogs, defaultStartMonth, onSave, onClose }: {
  item?: RecurringExpense | null;
  catalogs: Catalogs;
  defaultStartMonth: string;
  onSave: (input: RecurringExpenseInput) => Promise<unknown>;
  onClose: () => void;
}) => {
  const creditMethod = useMemo(
    () => catalogs.paymentMethods.find((method) => method.name.toLocaleLowerCase('pt-BR') === 'cartão de crédito'),
    [catalogs.paymentMethods],
  );
  const [kind, setKind] = useState<MoneyKind>(item?.kind ?? 'expense');
  const [description, setDescription] = useState(item?.description ?? '');
  const [startMonth, setStartMonth] = useState(item?.startMonth ?? (defaultStartMonth < currentMonthIso() ? currentMonthIso() : defaultStartMonth));
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(item?.paymentMethodId ?? '');
  const [cardId, setCardId] = useState(
    item?.cardId ?? (item?.paymentMethodId === creditMethod?.id ? catalogs.cards[0]?.id ?? '' : ''),
  );
  const [amount, setAmount] = useState(moneyValue(item?.plannedAmount));
  const [dueDay, setDueDay] = useState(String(item?.dueDay ?? 10));
  const [chargeDay, setChargeDay] = useState(item?.chargeDay === null || item?.chargeDay === undefined ? '' : String(item.chargeDay));
  const [active, setActive] = useState(item?.active ?? true);
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [existingItems, setExistingItems] = useState<RecurringExpense[]>([]);
  useEffect(() => {
    window.lionPocket.listRecurringExpenses().then(setExistingItems).catch(() => undefined);
  }, []);
  const normalizedDescription = description.trim().toLocaleLowerCase('pt-BR');
  const originalIdentity = item
    ? `${item.kind}:${item.description.trim().toLocaleLowerCase('pt-BR')}`
    : null;
  const currentIdentity = `${kind}:${normalizedDescription}`;
  const duplicate = currentIdentity !== originalIdentity
    ? existingItems.find((candidate) =>
        candidate.id !== item?.id
          && candidate.kind === kind
          && candidate.description.trim().toLocaleLowerCase('pt-BR') === normalizedDescription,
      )
    : undefined;
  const creditSelected = kind === 'expense' && paymentMethodId === creditMethod?.id;
  const selectedCard = catalogs.cards.find((card) => card.id === cardId);
  const numericChargeDay = Number(chargeDay);
  const firstChargeDate = selectedCard && numericChargeDay >= 1 && numericChargeDay <= 31
    ? dateForMonthDay(startMonth, numericChargeDay)
    : null;
  const firstCardDueDate = selectedCard && firstChargeDate
    ? selectedCard.closingDay === null
      ? nextCardDueDate(firstChargeDate, selectedCard.dueDay)
      : cardStatementDueDate(firstChargeDate, selectedCard.closingDay, selectedCard.dueDay)
    : null;
  const incompleteCardCycle = creditSelected && (!selectedCard || !firstChargeDate);
  const applyKind = (next: MoneyKind) => {
    setKind(next);
    setCategoryId('');
    if (next === 'income') {
      setPaymentMethodId('');
      setCardId('');
      setChargeDay('');
    }
  };
  const applyPaymentMethod = (nextPaymentMethodId: string) => {
    setPaymentMethodId(nextPaymentMethodId);
    if (nextPaymentMethodId !== creditMethod?.id) {
      setCardId('');
      setChargeDay('');
      return;
    }
    if (!cardId && catalogs.cards[0]) setCardId(catalogs.cards[0].id);
  };
  return (
    <Modal title={item ? 'Editar recorrência' : 'Nova recorrência'} description="Informe quando ela acontece; no cartão, o app escolhe a fatura automaticamente." onClose={onClose} medium>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        if (duplicate || incompleteCardCycle) return;
        await onSave({ id: item?.id, kind, description, startMonth, categoryId: categoryId || null, paymentMethodId: paymentMethodId || null, cardId: creditSelected ? cardId || null : null, plannedAmount: Number(amount), dueDay: selectedCard?.dueDay ?? Number(dueDay), chargeDay: creditSelected ? Number(chargeDay) : null, active, notes });
      }}>
        <div className="segmented form-grid__full">
          <button type="button" className={kind === 'expense' ? 'active' : ''} onClick={() => applyKind('expense')}>Saída fixa</button>
          <button type="button" className={kind === 'income' ? 'active' : ''} onClick={() => applyKind('income')}>Entrada fixa</button>
        </div>
        <label className="field form-grid__full"><span>Descrição</span><input required autoFocus aria-invalid={Boolean(duplicate)} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={kind === 'income' ? 'Ex.: Salário' : 'Ex.: Internet'} />{duplicate && <small className="field__error">Já existe uma {kind === 'income' ? 'entrada fixa' : 'saída fixa'} com esse nome. Edite a recorrência existente.</small>}</label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === kind).map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label={kind === 'income' ? 'Forma de recebimento' : 'Forma de pagamento'} value={paymentMethodId} onChange={applyPaymentMethod} disabled={kind === 'income'} options={[{ value: '', label: 'Não informada' }, ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name }))]} />
        <label className="field"><span>Valor mensal</span><div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
        {creditSelected
          ? <label className="field"><span>Dia mensal da cobrança</span><input required min="1" max="31" type="number" value={chargeDay} onChange={(event) => setChargeDay(event.target.value)} placeholder="Ex.: 20" /></label>
          : <label className="field"><span>{kind === 'income' ? 'Dia do recebimento' : 'Dia do vencimento'}</span><input required min="1" max="31" type="number" value={dueDay} onChange={(event) => setDueDay(event.target.value)} /></label>}
        {creditSelected && <SelectField label="Cartão" value={cardId} onChange={setCardId} options={[{ value: '', label: 'Selecione o cartão' }, ...catalogs.cards.map((card) => ({ value: card.id, label: `${card.name} · fecha ${card.closingDay ?? '?'} · vence ${card.dueDay}` }))]} />}
        <MonthField className={creditSelected ? '' : 'form-grid__full'} label={creditSelected ? 'Primeira cobrança em' : 'Começar em'} hint={creditSelected ? 'Escolha o mês em que a cobrança começa. O app usa o fechamento e o vencimento do cartão para decidir em qual fatura ela aparece.' : 'O primeiro lançamento será criado neste mês; meses anteriores ficam intocados.'} min={item ? undefined : currentMonthIso()} value={startMonth} onChange={setStartMonth} />
        {creditSelected && (
          <div className={`card-cycle-note form-grid__full ${incompleteCardCycle || selectedCard?.closingDay === null ? 'card-cycle-note--warning' : ''}`}>
            {!selectedCard
              ? <>Selecione um cartão para calcular a primeira fatura.</>
              : !firstChargeDate
                ? <>Informe o dia em que essa despesa é cobrada mensalmente no cartão.</>
                : selectedCard.closingDay === null
                  ? <>O <strong>{selectedCard.name}</strong> ainda está sem fechamento configurado. O vencimento estimado da primeira fatura é <strong>{formatDate(firstCardDueDate, 'dd/MM/yyyy')}</strong>.</>
                  : <>Primeira cobrança em <strong>{formatDate(firstChargeDate, 'dd/MM/yyyy')}</strong> · aparecerá na fatura com vencimento em <strong>{formatDate(firstCardDueDate, 'dd/MM/yyyy')}</strong>.</>}
          </div>
        )}
        <label className="field form-grid__full"><span>Observações</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <label className="toggle-row form-grid__full"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span><strong>{kind === 'income' ? 'Entrada ativa' : 'Saída ativa'}</strong><small>Inclui este lançamento nos próximos meses</small></span></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary" disabled={Boolean(duplicate) || incompleteCardCycle}>Salvar recorrência</button></div>
      </form>
    </Modal>
  );
};

export const InstallmentForm = ({ catalogs, onSave, onClose }: {
  catalogs: Catalogs;
  onSave: (input: InstallmentPurchaseInput) => Promise<unknown>;
  onClose: () => void;
}) => {
  const creditMethod = useMemo(() => catalogs.paymentMethods.find((method) => method.name === 'Cartão de crédito'), [catalogs]);
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [cardId, setCardId] = useState(catalogs.cards[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [total, setTotal] = useState('2');
  const [current, setCurrent] = useState('1');
  const [currentDueDate, setCurrentDueDate] = useState(() => {
    const card = catalogs.cards[0];
    if (!card) return todayIso();
    return card.closingDay === null
      ? nextCardDueDate(todayIso(), card.dueDay)
      : cardStatementDueDate(todayIso(), card.closingDay, card.dueDay);
  });
  const [notes, setNotes] = useState('');
  const totalAmount = Number(amount || 0) * Number(total || 0);
  const remainingInstallments = Math.max(0, Number(total || 0) - Number(current || 0) + 1);
  const applyCard = (nextCardId: string) => {
    setCardId(nextCardId);
    const card = catalogs.cards.find((item) => item.id === nextCardId);
    if (card) setCurrentDueDate(card.closingDay === null
      ? nextCardDueDate(todayIso(), card.dueDay)
      : cardStatementDueDate(todayIso(), card.closingDay, card.dueDay));
  };
  const applyTotal = (value: string) => {
    setTotal(value);
    const numeric = Number(value);
    if (numeric > 0 && Number(current) > numeric) setCurrent(value);
  };
  return (
    <Modal title="Nova compra parcelada" description="Informe a parcela deste mês; as anteriores entram como já pagas." onClose={onClose}>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ description, categoryId: categoryId || null, cardId: cardId || null, paymentMethodId: creditMethod?.id ?? null, installmentAmount: Number(amount), totalInstallments: Number(total), currentInstallment: Number(current), currentDueDate, notes });
      }}>
        <label className="field form-grid__full"><span>Compra</span><input required autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ex.: Notebook" /></label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === 'expense').map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label="Cartão" value={cardId} onChange={applyCard} options={[{ value: '', label: 'Não informado' }, ...catalogs.cards.map((card) => ({ value: card.id, label: `${card.name} · ${card.closingDay === null ? 'sem fechamento' : `fecha ${card.closingDay}`} · vence ${card.dueDay}` }))]} />
        <label className="field"><span>Valor da parcela</span><div className="money-input"><span>R$</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
        <label className="field"><span>Total de parcelas</span><input required min="1" max="120" type="number" value={total} onChange={(event) => applyTotal(event.target.value)} /></label>
        <label className="field"><span>Parcela deste mês</span><input required min="1" max={Math.max(1, Number(total || 1))} type="number" value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
        <DateField label="Vencimento desta parcela" value={currentDueDate} onChange={setCurrentDueDate} required />
        <div className="installment-total"><span>{remainingInstallments} {remainingInstallments === 1 ? 'parcela será criada' : 'parcelas serão criadas'} · total da compra</span><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalAmount)}</strong></div>
        <label className="field form-grid__full"><span>Observações</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Criar parcelas</button></div>
      </form>
    </Modal>
  );
};

export const GoalForm = ({ goal, catalogs, onSave, onClose }: {
  goal?: Goal | null;
  catalogs: Catalogs;
  onSave: (input: GoalInput) => Promise<unknown>;
  onClose: () => void;
}) => {
  const [name, setName] = useState(goal?.name ?? '');
  const [itemModel, setItemModel] = useState(goal?.itemModel ?? '');
  const [link, setLink] = useState(goal?.link ?? '');
  const [categoryId, setCategoryId] = useState(goal?.categoryId ?? '');
  const [targetAmount, setTargetAmount] = useState(moneyValue(goal?.targetAmount));
  const [savedAmount, setSavedAmount] = useState(moneyValue(goal?.savedAmount ?? 0));
  const [priority, setPriority] = useState<GoalInput['priority']>(goal?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(goal?.dueDate ?? '');
  const [status, setStatus] = useState<GoalInput['status']>(goal?.status ?? 'planned');
  const [notes, setNotes] = useState(goal?.notes ?? '');
  return (
    <Modal title={goal ? 'Editar objetivo' : 'Novo objetivo'} description="Um passo de cada vez fica bem mais leve." onClose={onClose} wide>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ id: goal?.id, name, itemModel, link, categoryId: categoryId || null, targetAmount: Number(targetAmount), savedAmount: Number(savedAmount), priority, dueDate: dueDate || null, status, notes });
      }}>
        <label className="field"><span>Nome do objetivo</span><input required autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Reserva de emergência" /></label>
        <label className="field"><span>Item ou modelo</span><input value={itemModel} onChange={(event) => setItemModel(event.target.value)} placeholder="Opcional" /></label>
        <label className="field form-grid__full"><span>Link</span><input type="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://…" /></label>
        <label className="field"><span>Valor desejado</span><div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} /></div></label>
        <label className="field"><span>Já reservado</span><div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={savedAmount} onChange={(event) => setSavedAmount(event.target.value)} /></div></label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === 'expense').map((category) => ({ value: category.id, label: category.name }))]} />
        <DateField label="Prazo" value={dueDate} onChange={setDueDate} />
        <SelectField label="Prioridade" value={priority} onChange={(value) => setPriority(value as GoalInput['priority'])} options={[{ value: 'high', label: 'Alta' }, { value: 'medium', label: 'Média' }, { value: 'low', label: 'Baixa' }]} />
        <SelectField label="Situação" value={status} onChange={(value) => setStatus(value as GoalInput['status'])} options={[{ value: 'planned', label: 'Planejado' }, { value: 'saving', label: 'Juntando' }, { value: 'completed', label: 'Concluído' }, { value: 'paused', label: 'Pausado' }, { value: 'cancelled', label: 'Cancelado' }]} />
        <label className="field form-grid__full"><span>Observações</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Salvar objetivo</button></div>
      </form>
    </Modal>
  );
};
