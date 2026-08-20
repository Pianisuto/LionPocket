import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, History, Link2 } from 'lucide-react';
import type {
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  MoneyKind,
  RecurringExpense,
  RecurringExpenseInput,
  RecurringFrequency,
  RecurringIntervalUnit,
  Transaction,
  TransactionInput,
  TransactionStatus,
  TransactionSuggestion,
} from '../shared/types';
import { DateField, Modal, MoneyField, MonthField, NumberField, SelectField } from './components';
import { cardStatementDueDate, currentMonthIso, currency, dateForMonthDay, formatDate, isPastDate, nextCardDueDate, settlementDateFor, todayIso } from './format';

const moneyValue = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

const settledStatusFor = (kind: MoneyKind): TransactionStatus => (kind === 'income' ? 'received' : 'paid');

const isSettled = (status: TransactionStatus) => status === 'paid' || status === 'received';

/** A situação que combina com a data: o que venceu antes de hoje já aconteceu. */
const statusForDate = (date: string, kind: MoneyKind): TransactionStatus =>
  isPastDate(date) ? settledStatusFor(kind) : 'planned';

const yearMonths = [
  ['01', 'Janeiro'], ['02', 'Fevereiro'], ['03', 'Março'], ['04', 'Abril'],
  ['05', 'Maio'], ['06', 'Junho'], ['07', 'Julho'], ['08', 'Agosto'],
  ['09', 'Setembro'], ['10', 'Outubro'], ['11', 'Novembro'], ['12', 'Dezembro'],
] as const;

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
  const [descriptionError, setDescriptionError] = useState('');
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
  const selectedPaymentMethod = catalogs.paymentMethods.find((item) => item.id === paymentMethodId);
  const selectedPaymentName = selectedPaymentMethod?.name.trim().toLocaleLowerCase('pt-BR') ?? '';
  const creditSelected = paymentMethodId === creditMethod?.id || Boolean(cardId);
  const settled = isSettled(status);
  const backfilling = isPastDate(dueDate);
  const nonCreditDateLabel = (() => {
    if (kind === 'income') return settled ? 'Data do recebimento' : 'Data prevista';
    if (selectedPaymentName === 'débito' || selectedPaymentName === 'dinheiro') return 'Data da compra';
    if (selectedPaymentName === 'pix') return 'Data do pagamento';
    if (selectedPaymentName === 'transferência') return 'Data da transferência';
    if (selectedPaymentName === 'boleto') return settled ? 'Data do pagamento' : 'Data de vencimento';
    return settled ? 'Data do pagamento' : 'Data prevista';
  })();

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
    setDescriptionError('');
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
            ? transaction?.settledDate ?? (transaction?.isOverdue ? todayIso() : settlementDateFor(dueDate))
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
            aria-invalid={Boolean(descriptionError)}
            aria-describedby={descriptionError ? `${descriptionId}-error` : undefined}
            value={description}
            onInvalid={(event) => {
              event.preventDefault();
              setDescriptionError('Informe uma descrição.');
            }}
            onChange={(event) => { setDescription(event.target.value); setDescriptionError(''); setSuggestionsOpen(true); }}
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
          {descriptionError && <small id={`${descriptionId}-error`} className="field__error" role="alert">{descriptionError}</small>}
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
        <MoneyField label="Valor planejado" required value={plannedAmount} onChange={applyPlanned} />

        {kind === 'expense' && (
          <SelectField label="Forma de pagamento" value={paymentMethodId} onChange={applyPaymentMethod} options={[
            { value: '', label: 'Não informada' },
            ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name })),
          ]} />
        )}
        {kind === 'expense' && creditSelected && (
          <SelectField label="Cartão" value={cardId} onChange={applyCard} options={[
            { value: '', label: 'Nenhum' },
            ...catalogs.cards.map((card) => ({
              value: card.id,
              label: card.name,
              details: [card.closingDay === null ? 'Sem fechamento' : `Fecha ${card.closingDay}`, `Vence ${card.dueDay}`],
            })),
          ]} />
        )}

        {cardId && <DateField label="Data da compra" value={purchaseDate} onChange={applyPurchaseDate} required={!transaction || Boolean(transaction.purchaseDate)} />}
        {!creditSelected && <DateField label={nonCreditDateLabel} value={dueDate} onChange={applyDueDate} required />}

        <SelectField label="Situação" value={status} onChange={(value) => applyStatus(value as TransactionStatus)} options={[
          { value: 'planned', label: 'Planejado' },
          { value: settledStatusFor(kind), label: kind === 'income' ? 'Recebido' : 'Pago' },
          { value: 'cancelled', label: 'Cancelado' },
        ]} />
        <MoneyField
          label={<>
            Valor real{' '}
            {settled && amountsLinked
              ? <small className="field__linked"><Link2 size={12} /> igual ao planejado</small>
              : <small>(opcional)</small>}
          </>}
          value={actualAmount}
          onChange={applyActual}
        />
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
  const [frequency, setFrequency] = useState<RecurringFrequency>(item?.frequency ?? 'monthly');
  const [startMonth, setStartMonth] = useState(item?.startMonth ?? (defaultStartMonth < currentMonthIso() ? currentMonthIso() : defaultStartMonth));
  const [startDate, setStartDate] = useState(
    item?.startDate ?? `${defaultStartMonth < currentMonthIso() ? currentMonthIso() : defaultStartMonth}-01`,
  );
  const [intervalCount, setIntervalCount] = useState(String(item?.intervalCount ?? 1));
  const [intervalUnit, setIntervalUnit] = useState<RecurringIntervalUnit>(item?.intervalUnit ?? 'months');
  const [anchorToActual, setAnchorToActual] = useState(item?.anchorToActual ?? false);
  const [manualMonths, setManualMonths] = useState<string[]>(item?.manualMonths ?? []);
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
  const [descriptionError, setDescriptionError] = useState('');
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
  const monthly = frequency === 'monthly';
  const manual = frequency === 'manual';
  const monthBased = monthly || manual;
  const scheduledAutomatically = frequency !== 'manual';
  const numericChargeDay = Number(chargeDay);
  const firstChargeDate = selectedCard
    ? monthly
      ? numericChargeDay >= 1 && numericChargeDay <= 31
        ? dateForMonthDay(startMonth, numericChargeDay)
        : null
      : scheduledAutomatically && startDate
        ? startDate
        : null
    : null;
  const firstCardDueDate = selectedCard && firstChargeDate
    ? selectedCard.closingDay === null
      ? nextCardDueDate(firstChargeDate, selectedCard.dueDay)
      : cardStatementDueDate(firstChargeDate, selectedCard.closingDay, selectedCard.dueDay)
    : null;
  const incompleteCardCycle = creditSelected && (
    !selectedCard
    || monthBased && !(numericChargeDay >= 1 && numericChargeDay <= 31)
    || !monthBased && scheduledAutomatically && !firstChargeDate
  );
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
        const effectiveStartMonth = monthBased ? startMonth : startDate.slice(0, 7) || startMonth;
        await onSave({ id: item?.id, kind, description, frequency, startMonth: effectiveStartMonth, startDate: monthBased ? undefined : startDate, intervalCount: Number(intervalCount), intervalUnit, anchorToActual, manualMonths, categoryId: categoryId || null, paymentMethodId: paymentMethodId || null, cardId: creditSelected ? cardId || null : null, plannedAmount: Number(amount), dueDay: selectedCard?.dueDay ?? Number(dueDay), chargeDay: creditSelected && monthBased ? Number(chargeDay) : null, active, notes });
      }}>
        <div className="segmented form-grid__full">
          <button type="button" className={kind === 'expense' ? 'active' : ''} onClick={() => applyKind('expense')}>Saída fixa</button>
          <button type="button" className={kind === 'income' ? 'active' : ''} onClick={() => applyKind('income')}>Entrada fixa</button>
        </div>
        <label className="field form-grid__full"><span>Descrição</span><input required autoFocus aria-invalid={Boolean(duplicate || descriptionError)} value={description} onInvalid={(event) => { event.preventDefault(); setDescriptionError('Informe uma descrição.'); }} onChange={(event) => { setDescription(event.target.value); setDescriptionError(''); }} placeholder={kind === 'income' ? 'Ex.: Salário' : 'Ex.: Internet'} />{descriptionError && <small className="field__error" role="alert">{descriptionError}</small>}{duplicate && <small className="field__error">Já existe uma {kind === 'income' ? 'entrada fixa' : 'saída fixa'} com esse nome. Edite a recorrência existente.</small>}</label>
        <SelectField className="form-grid__full" label="Frequência" value={frequency} onChange={(value) => setFrequency(value as RecurringFrequency)} options={[
          { value: 'once', label: 'Não recorrente' },
          { value: 'weekly', label: 'Semanal' },
          { value: 'monthly', label: 'Mensal' },
          { value: 'custom', label: 'Intervalo personalizado' },
          { value: 'manual', label: 'Manual (escolher meses)' },
        ]} />
        {manual && (
          <div className="manual-months form-grid__full" role="group" aria-label="Meses em que o lançamento será criado">
            <div className="manual-months__header">
              <div><strong>Escolha os meses</strong><small>A seleção se repete todos os anos</small></div>
              <span>{manualMonths.length ? `${manualMonths.length} ${manualMonths.length === 1 ? 'marcado' : 'marcados'}` : 'Nenhum marcado'}</span>
            </div>
            <div className="manual-months__grid">
              {yearMonths.map(([value, label]) => {
                const selected = manualMonths.includes(value);
                return <button key={value} type="button" className={selected ? 'active' : ''} aria-pressed={selected} onClick={() => setManualMonths((current) => selected ? current.filter((month) => month !== value) : [...current, value].sort())}><span>{label}</span><i aria-hidden="true">{selected && <Check size={13} strokeWidth={3} />}</i></button>;
              })}
            </div>
          </div>
        )}
        {frequency === 'custom' && <>
          <NumberField label="Repetir a cada" required min={1} max={999} value={intervalCount} onChange={setIntervalCount} />
          <SelectField label="Unidade do intervalo" value={intervalUnit} onChange={(value) => setIntervalUnit(value as RecurringIntervalUnit)} options={[
            { value: 'days', label: 'Dias' },
            { value: 'weeks', label: 'Semanas' },
            { value: 'months', label: 'Meses' },
            { value: 'years', label: 'Anos' },
          ]} />
        </>}
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === kind).map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label={kind === 'income' ? 'Forma de recebimento' : 'Forma de pagamento'} value={paymentMethodId} onChange={applyPaymentMethod} disabled={kind === 'income'} options={[{ value: '', label: 'Não informada' }, ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name }))]} />
        <MoneyField label="Valor mensal" required value={amount} onChange={setAmount} />
        {creditSelected && monthBased
          ? <NumberField label="Dia mensal da cobrança" required min={1} max={31} value={chargeDay} onChange={setChargeDay} placeholder="Ex.: 20" />
          : monthBased && <NumberField label={kind === 'income' ? 'Dia do recebimento' : 'Dia do vencimento'} required min={1} max={31} value={dueDay} onChange={setDueDay} />}
        {creditSelected && <SelectField label="Cartão" value={cardId} onChange={setCardId} options={[{ value: '', label: 'Selecione o cartão' }, ...catalogs.cards.map((card) => ({
          value: card.id,
          label: card.name,
          details: [card.closingDay === null ? 'Sem fechamento' : `Fecha ${card.closingDay}`, `Vence ${card.dueDay}`],
        }))]} />}
        {monthBased && <MonthField className={creditSelected ? '' : 'form-grid__full'} label={manual ? 'Começar a partir de' : creditSelected ? 'Primeira cobrança em' : 'Começar em'} hint={manual ? 'A seleção de meses se repete todos os anos a partir daqui.' : creditSelected ? 'Escolha o mês em que a cobrança começa. O app usa o fechamento e o vencimento do cartão para decidir em qual fatura ela aparece.' : 'O primeiro lançamento será criado neste mês; meses anteriores ficam intocados.'} min={item ? undefined : currentMonthIso()} value={startMonth} onChange={setStartMonth} />}
        {!monthBased && scheduledAutomatically && <DateField className="form-grid__full" label={frequency === 'once' ? 'Data do lançamento' : 'Primeira ocorrência'} value={startDate} onChange={setStartDate} required />}
        {frequency === 'custom' && (
          <label className="toggle-row form-grid__full"><input type="checkbox" checked={anchorToActual} onChange={(event) => setAnchorToActual(event.target.checked)} /><span><strong>Calcular a próxima pela data efetiva</strong><small>Se a compra ou o pagamento atrasar, a previsão seguinte acompanha a data real.</small></span></label>
        )}
        {creditSelected && scheduledAutomatically && (
          <div className={`card-cycle-note form-grid__full ${incompleteCardCycle || selectedCard?.closingDay === null ? 'card-cycle-note--warning' : ''}`}>
            {!selectedCard
              ? <>Selecione um cartão para calcular a primeira fatura.</>
              : !firstChargeDate
                ? <>{monthly ? 'Informe o dia em que essa despesa é cobrada mensalmente no cartão.' : 'Informe a data da primeira ocorrência.'}</>
                : selectedCard.closingDay === null
                  ? <>O <strong>{selectedCard.name}</strong> ainda está sem fechamento configurado. O vencimento estimado da primeira fatura é <strong>{formatDate(firstCardDueDate, 'dd/MM/yyyy')}</strong>.</>
                  : <>Primeira cobrança em <strong>{formatDate(firstChargeDate, 'dd/MM/yyyy')}</strong> · aparecerá na fatura com vencimento em <strong>{formatDate(firstCardDueDate, 'dd/MM/yyyy')}</strong>.</>}
          </div>
        )}
        <label className="field form-grid__full"><span>Observações</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <label className="toggle-row form-grid__full"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span><strong>{kind === 'income' ? 'Entrada ativa' : 'Saída ativa'}</strong><small>{frequency === 'manual' ? 'Cria lançamentos somente nos meses marcados' : frequency === 'once' ? 'Cria a ocorrência única informada' : 'Gera os próximos lançamentos automaticamente'}</small></span></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary" disabled={Boolean(duplicate) || incompleteCardCycle || manual && manualMonths.length === 0}>Salvar recorrência</button></div>
      </form>
    </Modal>
  );
};

export const InstallmentForm = ({ item, catalogs, onSave, onClose }: {
  item?: InstallmentPurchase | null;
  catalogs: Catalogs;
  onSave: (input: InstallmentPurchaseInput) => Promise<unknown>;
  onClose: () => void;
}) => {
  const creditMethod = useMemo(() => catalogs.paymentMethods.find((method) => method.name === 'Cartão de crédito'), [catalogs]);
  const dueDateForPurchase = (date: string, nextCardId: string) => {
    const card = catalogs.cards.find((candidate) => candidate.id === nextCardId);
    if (!date || !card) return date || todayIso();
    return card.closingDay === null
      ? nextCardDueDate(date, card.dueDay)
      : cardStatementDueDate(date, card.closingDay, card.dueDay);
  };
  const initialCardId = item?.cardId ?? catalogs.cards[0]?.id ?? '';
  const initialPurchaseDate = item?.purchaseDate ?? (item ? '' : todayIso());
  const initialCurrent = item?.viewedInstallment ?? 1;
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [cardId, setCardId] = useState(initialCardId);
  const [amount, setAmount] = useState(moneyValue(item?.installmentAmount));
  const [total, setTotal] = useState(String(item?.totalInstallments ?? 2));
  const [current, setCurrent] = useState(String(initialCurrent));
  const [purchaseDate, setPurchaseDate] = useState(initialPurchaseDate);
  const [currentDueDate, setCurrentDueDate] = useState(
    item?.viewedDueDate ?? dueDateForPurchase(initialPurchaseDate, initialCardId),
  );
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [descriptionError, setDescriptionError] = useState('');
  const totalAmount = Number(amount || 0) * Number(total || 0);
  const remainingInstallments = Math.max(0, Number(total || 0) - Number(current || 0) + 1);
  const applyCard = (nextCardId: string) => {
    setCardId(nextCardId);
    if (purchaseDate) setCurrentDueDate(dueDateForPurchase(purchaseDate, nextCardId));
  };
  const applyPurchaseDate = (value: string) => {
    setPurchaseDate(value);
    if (value) setCurrentDueDate(dueDateForPurchase(value, cardId));
  };
  const applyTotal = (value: string) => {
    setTotal(value);
    const numeric = Number(value);
    if (numeric > 0 && Number(current) > numeric) setCurrent(value);
  };
  const applyCurrent = (value: string) => {
    setCurrent(value);
    if (purchaseDate && Number(value) > 0) setCurrentDueDate(dueDateForPurchase(purchaseDate, cardId));
  };
  return (
    <Modal
      title={item ? 'Editar compra parcelada' : 'Nova compra parcelada'}
      description={item
        ? 'As alterações afetam as parcelas em aberto; valores e vencimentos já concluídos são preservados.'
        : 'Informe a parcela deste mês; as anteriores entram como já pagas.'}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ id: item?.id, description, categoryId: categoryId || null, cardId: cardId || null, paymentMethodId: creditMethod?.id ?? null, installmentAmount: Number(amount), totalInstallments: Number(total), currentInstallment: Number(current), originalCurrentInstallment: item?.viewedInstallment, purchaseDate: purchaseDate || null, currentDueDate, notes });
      }}>
        <label className="field form-grid__full"><span>Compra</span><input required autoFocus aria-invalid={Boolean(descriptionError)} value={description} onInvalid={(event) => { event.preventDefault(); setDescriptionError('Informe o nome da compra.'); }} onChange={(event) => { setDescription(event.target.value); setDescriptionError(''); }} placeholder="Ex.: Notebook" />{descriptionError && <small className="field__error" role="alert">{descriptionError}</small>}</label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === 'expense').map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label="Cartão" value={cardId} onChange={applyCard} options={[{ value: '', label: 'Não informado' }, ...catalogs.cards.map((card) => ({
          value: card.id,
          label: card.name,
          details: [card.closingDay === null ? 'Sem fechamento' : `Fecha ${card.closingDay}`, `Vence ${card.dueDay}`],
        }))]} />
        <MoneyField label="Valor da parcela" required min={0.01} value={amount} onChange={setAmount} />
        <NumberField label="Total de parcelas" required min={1} max={120} value={total} onChange={applyTotal} />
        <NumberField label={item ? 'Parcela exibida neste mês' : <>Parcela que está nesta fatura <small>Use 1 para uma compra nova</small></>} required min={1} max={Math.max(1, Number(total || 1))} value={current} onChange={applyCurrent} />
        <DateField label="Data da compra" value={purchaseDate} onChange={applyPurchaseDate} required={!item || Boolean(purchaseDate)} />
        <div className="installment-total"><span>{item ? 'Parcelas em aberto serão atualizadas' : `${remainingInstallments} ${remainingInstallments === 1 ? 'parcela será criada' : 'parcelas serão criadas'}`} · total da compra</span><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalAmount)}</strong></div>
        <label className="field form-grid__full"><span>Observações</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">{item ? 'Salvar alterações' : 'Criar parcelas'}</button></div>
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
  const [nameError, setNameError] = useState('');
  const [linkError, setLinkError] = useState('');
  return (
    <Modal title={goal ? 'Editar objetivo' : 'Novo objetivo'} description="Um passo de cada vez fica bem mais leve." onClose={onClose} wide>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ id: goal?.id, name, itemModel, link, categoryId: categoryId || null, targetAmount: Number(targetAmount), savedAmount: Number(savedAmount), priority, dueDate: dueDate || null, status, notes });
      }}>
        <label className="field"><span>Nome do objetivo</span><input required autoFocus aria-invalid={Boolean(nameError)} value={name} onInvalid={(event) => { event.preventDefault(); setNameError('Informe um nome para o objetivo.'); }} onChange={(event) => { setName(event.target.value); setNameError(''); }} placeholder="Ex.: Reserva de emergência" />{nameError && <small className="field__error" role="alert">{nameError}</small>}</label>
        <label className="field"><span>Item ou modelo</span><input value={itemModel} onChange={(event) => setItemModel(event.target.value)} placeholder="Opcional" /></label>
        <label className="field form-grid__full"><span>Link</span><input type="url" aria-invalid={Boolean(linkError)} value={link} onInvalid={(event) => { event.preventDefault(); setLinkError('Informe um link válido, começando com http:// ou https://.'); }} onChange={(event) => { setLink(event.target.value); setLinkError(''); }} placeholder="https://…" />{linkError && <small className="field__error" role="alert">{linkError}</small>}</label>
        <MoneyField label="Valor desejado" required value={targetAmount} onChange={setTargetAmount} />
        <MoneyField label="Já reservado" required value={savedAmount} onChange={setSavedAmount} />
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
