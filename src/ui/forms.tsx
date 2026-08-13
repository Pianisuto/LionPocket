import { useMemo, useState } from 'react';
import type {
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchaseInput,
  RecurringExpense,
  RecurringExpenseInput,
  Transaction,
  TransactionInput,
} from '../shared/types';
import { Modal } from './components';
import { todayIso } from './format';

const moneyValue = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

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
  onSave: (input: TransactionInput) => Promise<void>;
  onClose: () => void;
}) => {
  const [kind, setKind] = useState(transaction?.kind ?? 'expense');
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [categoryId, setCategoryId] = useState(transaction?.categoryId ?? '');
  const [plannedAmount, setPlannedAmount] = useState(moneyValue(transaction?.plannedAmount));
  const [actualAmount, setActualAmount] = useState(moneyValue(transaction?.actualAmount));
  const [dueDate, setDueDate] = useState(transaction?.dueDate ?? defaultDate);
  const [status, setStatus] = useState(transaction?.status ?? 'planned');
  const [paymentMethodId, setPaymentMethodId] = useState(transaction?.paymentMethodId ?? '');
  const [cardId, setCardId] = useState(transaction?.cardId ?? '');
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const categories = catalogs.categories.filter((category) => category.kind === kind);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const finalStatus = kind === 'income' && status === 'paid' ? 'received' : status;
      await onSave({
        id: transaction?.id,
        kind,
        description,
        categoryId: categoryId || null,
        plannedAmount: Number(plannedAmount),
        actualAmount: actualAmount === '' ? null : Number(actualAmount),
        dueDate,
        settledDate: ['paid', 'received'].includes(finalStatus) ? transaction?.settledDate ?? todayIso() : null,
        status: finalStatus,
        paymentMethodId: paymentMethodId || null,
        cardId: cardId || null,
        notes,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={transaction ? 'Editar lançamento' : 'Novo lançamento'} description="Registre o planejado agora e confirme o valor real quando acontecer." onClose={onClose} wide>
      <form onSubmit={submit} className="form-grid">
        <div className="segmented form-grid__full">
          <button type="button" className={kind === 'expense' ? 'active' : ''} onClick={() => { setKind('expense'); setCategoryId(''); setStatus('planned'); }}>Saída</button>
          <button type="button" className={kind === 'income' ? 'active' : ''} onClick={() => { setKind('income'); setCategoryId(''); setStatus('planned'); }}>Entrada</button>
        </div>
        <label className="field form-grid__full">
          <span>Descrição</span>
          <input required autoFocus value={description} onChange={(event) => setDescription(event.target.value)} placeholder={kind === 'expense' ? 'Ex.: Supermercado' : 'Ex.: Salário'} />
        </label>
        <label className="field">
          <span>Categoria</span>
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">Sem categoria</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Data prevista</span>
          <input required type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Valor planejado</span>
          <div className="money-input"><span>R$</span><input required min="0" step="0.01" type="number" value={plannedAmount} onChange={(event) => setPlannedAmount(event.target.value)} /></div>
        </label>
        <label className="field">
          <span>Valor real <small>(opcional)</small></span>
          <div className="money-input"><span>R$</span><input min="0" step="0.01" type="number" value={actualAmount} onChange={(event) => setActualAmount(event.target.value)} /></div>
        </label>
        <label className="field">
          <span>Situação</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as TransactionInput['status'])}>
            <option value="planned">Planejado</option>
            <option value={kind === 'income' ? 'received' : 'paid'}>{kind === 'income' ? 'Recebido' : 'Pago'}</option>
            <option value="cancelled">Cancelado</option>
          </select>
        </label>
        <label className="field">
          <span>Forma de pagamento</span>
          <select value={paymentMethodId} onChange={(event) => setPaymentMethodId(event.target.value)} disabled={kind === 'income'}>
            <option value="">Não informada</option>
            {catalogs.paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Cartão</span>
          <select value={cardId} onChange={(event) => setCardId(event.target.value)} disabled={kind === 'income'}>
            <option value="">Nenhum</option>
            {catalogs.cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}
          </select>
        </label>
        <label className="field form-grid__full">
          <span>Observações</span>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Algo importante sobre este lançamento?" rows={3} />
        </label>
        <div className="modal__actions form-grid__full">
          <button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button>
          <button className="button button--primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar lançamento'}</button>
        </div>
      </form>
    </Modal>
  );
};

export const RecurringForm = ({ item, catalogs, onSave, onClose }: {
  item?: RecurringExpense | null;
  catalogs: Catalogs;
  onSave: (input: RecurringExpenseInput) => Promise<void>;
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
        <label className="field"><span>Categoria</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Sem categoria</option>{catalogs.categories.filter((category) => category.kind === 'expense').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="field"><span>Forma de pagamento</span><select value={paymentMethodId} onChange={(event) => setPaymentMethodId(event.target.value)}><option value="">Não informada</option>{catalogs.paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
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
  onSave: (input: InstallmentPurchaseInput) => Promise<void>;
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
        <label className="field"><span>Categoria</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Sem categoria</option>{catalogs.categories.filter((category) => category.kind === 'expense').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="field"><span>Cartão</span><select value={cardId} onChange={(event) => setCardId(event.target.value)}><option value="">Não informado</option>{catalogs.cards.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}</select></label>
        <label className="field"><span>Valor da parcela</span><div className="money-input"><span>R$</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
        <label className="field"><span>Quantidade</span><input required min="2" max="120" type="number" value={total} onChange={(event) => setTotal(event.target.value)} /></label>
        <label className="field"><span>Primeiro vencimento</span><input required type="date" value={firstDueDate} onChange={(event) => setFirstDueDate(event.target.value)} /></label>
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
  onSave: (input: GoalInput) => Promise<void>;
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
        <label className="field"><span>Categoria</span><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Sem categoria</option>{catalogs.categories.filter((category) => category.kind === 'expense').map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="field"><span>Prazo</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        <label className="field"><span>Prioridade</span><select value={priority} onChange={(event) => setPriority(event.target.value as GoalInput['priority'])}><option value="high">Alta</option><option value="medium">Média</option><option value="low">Baixa</option></select></label>
        <label className="field"><span>Situação</span><select value={status} onChange={(event) => setStatus(event.target.value as GoalInput['status'])}><option value="planned">Planejado</option><option value="saving">Juntando</option><option value="completed">Concluído</option><option value="paused">Pausado</option><option value="cancelled">Cancelado</option></select></label>
        <label className="field form-grid__full"><span>Observações</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="modal__actions form-grid__full"><button type="button" className="button button--ghost" onClick={onClose}>Cancelar</button><button className="button button--primary">Salvar objetivo</button></div>
      </form>
    </Modal>
  );
};

