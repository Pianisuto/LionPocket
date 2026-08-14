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
import { DateField, Modal, SelectField } from './components';
import { currency, isPastDate, settlementDateFor, todayIso } from './format';

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
  const settled = isSettled(status);
  const backfilling = isPastDate(dueDate);

  useEffect(() => {
    const term = description.trim();
    if (!suggestionsOpen || term.length < 2) {
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
  }, [description, kind, suggestionsOpen]);

  const applyKind = (next: MoneyKind) => {
    setKind(next);
    setCategoryId('');
    if (next === 'income') {
      setPaymentMethodId('');
      setCardId('');
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
    if (item.paymentMethodId && !paymentMethodId && kind === 'expense') setPaymentMethodId(item.paymentMethodId);
    if (item.cardId && !cardId && kind === 'expense') setCardId(item.cardId);
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
        className="form-grid"
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
            aria-expanded={suggestionsOpen && suggestions.length > 0}
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
          {suggestionsOpen && suggestions.length > 0 && (
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
        <DateField label="Data prevista" value={dueDate} onChange={applyDueDate} required />
        <label className="field">
          <span>Valor planejado</span>
          <div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={plannedAmount} onChange={(event) => applyPlanned(event.target.value)} /></div>
        </label>
        <label className="field">
          <span>
            Valor real{' '}
            {settled && amountsLinked
              ? <small className="field__linked"><Link2 size={12} /> igual ao planejado</small>
              : <small>(opcional)</small>}
          </span>
          <div className="money-input"><span>R$</span><input min="0" step="0.01" type="number" value={actualAmount} onChange={(event) => applyActual(event.target.value)} /></div>
        </label>
        <SelectField label="Situação" value={status} onChange={(value) => applyStatus(value as TransactionStatus)} options={[
          { value: 'planned', label: 'Planejado' },
          { value: settledStatusFor(kind), label: kind === 'income' ? 'Recebido' : 'Pago' },
          { value: 'cancelled', label: 'Cancelado' },
        ]} />
        <SelectField label="Forma de pagamento" value={paymentMethodId} onChange={setPaymentMethodId} disabled={kind === 'income'} options={[
          { value: '', label: 'Não informada' },
          ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name })),
        ]} />
        <SelectField label="Cartão" value={cardId} onChange={setCardId} disabled={kind === 'income'} options={[
          { value: '', label: 'Nenhum' },
          ...catalogs.cards.map((card) => ({ value: card.id, label: card.name })),
        ]} />
        <label className="field form-grid__full">
          <span>Observações</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Algo importante sobre este lançamento?" rows={3} />
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

export const RecurringForm = ({ item, catalogs, onSave, onClose }: {
  item?: RecurringExpense | null;
  catalogs: Catalogs;
  onSave: (input: RecurringExpenseInput) => Promise<unknown>;
  onClose: () => void;
}) => {
  const [description, setDescription] = useState(item?.description ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(item?.paymentMethodId ?? '');
  const [amount, setAmount] = useState(moneyValue(item?.plannedAmount));
  const [dueDay, setDueDay] = useState(String(item?.dueDay ?? 10));
  const [active, setActive] = useState(item?.active ?? true);
  const [notes, setNotes] = useState(item?.notes ?? '');
  return (
    <Modal title={item ? 'Editar despesa fixa' : 'Nova despesa fixa'} description="Ela será incluída automaticamente em cada mês." onClose={onClose}>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ id: item?.id, description, categoryId: categoryId || null, paymentMethodId: paymentMethodId || null, plannedAmount: Number(amount), dueDay: Number(dueDay), active, notes });
      }}>
        <label className="field form-grid__full"><span>Descrição</span><input required autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ex.: Internet" /></label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === 'expense').map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label="Forma de pagamento" value={paymentMethodId} onChange={setPaymentMethodId} options={[{ value: '', label: 'Não informada' }, ...catalogs.paymentMethods.map((method) => ({ value: method.id, label: method.name }))]} />
        <label className="field"><span>Valor mensal</span><div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
        <label className="field"><span>Dia do vencimento</span><input required min="1" max="31" type="number" value={dueDay} onChange={(event) => setDueDay(event.target.value)} /></label>
        <label className="field form-grid__full"><span>Observações</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <label className="toggle-row form-grid__full"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span><strong>Despesa ativa</strong><small>Inclui esta conta nos próximos meses</small></span></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Salvar despesa</button></div>
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
  const [firstDueDate, setFirstDueDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const totalAmount = Number(amount || 0) * Number(total || 0);
  return (
    <Modal title="Nova compra parcelada" description="Cadastre uma vez; o LionPocket cria todas as parcelas." onClose={onClose}>
      <form className="form-grid" onSubmit={async (event) => {
        event.preventDefault();
        await onSave({ description, categoryId: categoryId || null, cardId: cardId || null, paymentMethodId: creditMethod?.id ?? null, installmentAmount: Number(amount), totalInstallments: Number(total), firstDueDate, notes });
      }}>
        <label className="field form-grid__full"><span>Compra</span><input required autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ex.: Notebook" /></label>
        <SelectField label="Categoria" value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Sem categoria' }, ...catalogs.categories.filter((category) => category.kind === 'expense').map((category) => ({ value: category.id, label: category.name }))]} />
        <SelectField label="Cartão" value={cardId} onChange={setCardId} options={[{ value: '', label: 'Não informado' }, ...catalogs.cards.map((card) => ({ value: card.id, label: card.name }))]} />
        <label className="field"><span>Valor da parcela</span><div className="money-input"><span>R$</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
        <label className="field"><span>Quantidade</span><input required min="2" max="120" type="number" value={total} onChange={(event) => setTotal(event.target.value)} /></label>
        <DateField label="Primeiro vencimento" value={firstDueDate} onChange={setFirstDueDate} required />
        <div className="installment-total"><span>Valor total da compra</span><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalAmount)}</strong></div>
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
