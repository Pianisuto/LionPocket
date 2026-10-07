import React, { useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  cardStatementDueDate,
  externalGoalUrl,
  isValidDate,
  nextCardDueDate,
  safetyMarginToCents,
} from '@lionpocket/core';
import type {
  Catalogs,
  Goal,
  GoalInput,
  InstallmentPurchase,
  InstallmentPurchaseInput,
  MoneyKind,
  RecurringExpense,
  RecurringExpenseInput,
} from '@lionpocket/core';
import { parseMoney } from '../transactionForm';
import {
  Button,
  Choice,
  DateField,
  MonthField,
  Field,
  ScreenHeader,
  useStyles,
  money,
} from './components';

function Editor({
  title,
  onClose,
  onSave,
  children,
  onRemove,
}: {
  title: string;
  onClose: () => void;
  onSave: () => Promise<void>;
  children: React.ReactNode;
  onRemove?: () => Promise<void>;
}) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const save = async (action = onSave) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    Keyboard.dismiss();
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível salvar.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <ScreenHeader title={title} onClose={onClose} disabled={busy} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            {children}
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
          </ScrollView>
          <View style={styles.formFooter}>
            {onRemove && <Button label="Remover margem" tone="danger" disabled={busy} onPress={() => void save(onRemove)} />}
            <Button
              label={busy ? 'Salvando…' : 'Salvar'}
              tone="primary"
              disabled={busy}
              onPress={() => void save()}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
function References({
  catalogs,
  kind,
  categoryId,
  setCategory,
  paymentId,
  setPayment,
  cardId,
  setCard,
}: {
  catalogs: Catalogs;
  kind: MoneyKind;
  categoryId: string;
  setCategory: (v: string) => void;
  paymentId: string;
  setPayment: (v: string) => void;
  cardId: string;
  setCard: (v: string) => void;
}) {
  return (
    <>
      <Choice
        label="Categoria"
        value={categoryId}
        onChange={setCategory}
        options={[
          { value: '', label: 'Sem categoria' },
          ...catalogs.categories
            .filter((c) => c.kind === kind)
            .map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <Choice
        label="Forma de pagamento"
        value={paymentId}
        onChange={setPayment}
        options={[
          { value: '', label: 'Sem forma de pagamento' },
          ...catalogs.paymentMethods.map((p) => ({
            value: p.id,
            label: p.name,
          })),
        ]}
      />
      {kind === 'expense' && (
        <Choice
          label="Cartão"
          value={cardId}
          onChange={setCard}
          options={[
            { value: '', label: 'Sem cartão' },
            ...catalogs.cards.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
      )}
    </>
  );
}

export const frequencies = [
  { value: 'once', label: 'Uma vez' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensal' },
  { value: 'custom', label: 'Intervalo personalizado' },
  { value: 'manual', label: 'Meses escolhidos' },
];
export function RecurringEditor({
  item,
  catalogs,
  month,
  onClose,
  onSave,
}: {
  item: RecurringExpense | null;
  catalogs: Catalogs;
  month: string;
  onClose: () => void;
  onSave: (input: RecurringExpenseInput) => Promise<void>;
}) {
  const styles = useStyles();
  const [description, setDescription] = useState(item?.description ?? '');
  const [kind, setKind] = useState<MoneyKind>(item?.kind ?? 'expense');
  const [active, setActive] = useState(item?.active ?? true);
  const [amount, setAmount] = useState(
    String(item?.plannedAmount ?? '').replace('.', ','),
  );
  const [startMonth, setStartMonth] = useState(item?.startMonth ?? month);
  const [startDate, setStartDate] = useState(item?.startDate ?? `${month}-01`);
  const [frequency, setFrequency] = useState(item?.frequency ?? 'monthly');
  const [interval, setInterval] = useState(String(item?.intervalCount ?? 1));
  const [unit, setUnit] = useState(item?.intervalUnit ?? 'months');
  const [anchor, setAnchor] = useState(item?.anchorToActual ?? false);
  const [months, setMonths] = useState(item?.manualMonths ?? []);
  const [day, setDay] = useState(String(item?.dueDay ?? 10));
  const [chargeDay, setChargeDay] = useState(String(item?.chargeDay ?? 1));
  const [category, setCategory] = useState(item?.categoryId ?? '');
  const [payment, setPayment] = useState(item?.paymentMethodId ?? '');
  const [card, setCard] = useState(item?.cardId ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  return (
    <Editor
      title={item ? 'Editar recorrência' : 'Nova recorrência'}
      onClose={onClose}
      onSave={() =>
        onSave({
          id: item?.id,
          kind,
          active,
          description,
          plannedAmount: parseMoney(amount, true),
          startMonth,
          startDate,
          frequency,
          intervalCount: Number(interval),
          intervalUnit: unit,
          anchorToActual: anchor,
          manualMonths: months,
          dueDay: Number(day),
          chargeDay: Number(chargeDay),
          categoryId: category || null,
          paymentMethodId: payment || null,
          cardId: kind === 'expense' ? card || null : null,
          notes,
        })
      }
    >
      <Field label="Descrição" value={description} onChange={setDescription} />
      <Choice
        label="Tipo"
        value={kind}
        options={[
          { value: 'expense', label: 'Saída' },
          { value: 'income', label: 'Entrada' },
        ]}
        onChange={(v) => {
          setKind(v as MoneyKind);
          setCategory('');
          setCard('');
        }}
      />
      <Field
        label="Valor previsto"
        value={amount}
        numeric
        onChange={setAmount}
      />
      <Choice
        label="Situação"
        value={active ? 'active' : 'paused'}
        options={[
          { value: 'active', label: 'Ativa' },
          { value: 'paused', label: 'Pausada' },
        ]}
        onChange={(v) => setActive(v === 'active')}
      />
      <Choice
        label="Frequência"
        value={frequency}
        options={frequencies}
        onChange={(v) => setFrequency(v as typeof frequency)}
      />
      <MonthField
        label="Mês de início"
        value={startMonth}
        onChange={setStartMonth}
      />
      {frequency !== 'monthly' && frequency !== 'manual' && (
        <DateField
          label="Primeira ocorrência"
          value={startDate}
          onChange={setStartDate}
        />
      )}
      {frequency === 'custom' && (
        <>
          <Field
            label="A cada"
            value={interval}
            numeric
            onChange={setInterval}
          />
          <Choice
            label="Unidade"
            value={unit}
            onChange={(v) => setUnit(v as typeof unit)}
            options={[
              { value: 'days', label: 'Dias' },
              { value: 'weeks', label: 'Semanas' },
              { value: 'months', label: 'Meses' },
              { value: 'years', label: 'Anos' },
            ]}
          />
          <Choice
            label="Referência do intervalo"
            value={anchor ? 'actual' : 'fixed'}
            onChange={(v) => setAnchor(v === 'actual')}
            options={[
              { value: 'fixed', label: 'Calendário fixo' },
              { value: 'actual', label: 'Última data efetiva' },
            ]}
          />
          <Text style={styles.muted}>
            A data efetiva desloca as próximas previsões. Para cartão, usa a
            data da compra; para outras formas, o pagamento ou recebimento.
          </Text>
        </>
      )}
      {frequency === 'manual' && (
        <View style={styles.field}>
          <Text style={styles.label}>Meses do ano</Text>
          <View style={styles.row}>
            {Array.from({ length: 12 }, (_, i) =>
              String(i + 1).padStart(2, '0'),
            ).map((m) => (
              <Button
                key={m}
                label={`${m}${months.includes(m) ? ' ✓' : ''}`}
                onPress={() =>
                  setMonths(
                    months.includes(m)
                      ? months.filter((v) => v !== m)
                      : [...months, m].sort(),
                  )
                }
              />
            ))}
          </View>
        </View>
      )}
      <References
        catalogs={catalogs}
        kind={kind}
        categoryId={category}
        setCategory={setCategory}
        paymentId={payment}
        setPayment={setPayment}
        cardId={card}
        setCard={setCard}
      />
      {card && kind === 'expense' ? (
        <>
          {(frequency === 'monthly' || frequency === 'manual') && (
            <Field
              label="Dia da cobrança no cartão"
              value={chargeDay}
              numeric
              onChange={setChargeDay}
              hint="1 a 31"
            />
          )}
          <Text style={styles.muted}>
            A cobrança entra na fatura conforme fechamento e vencimento do
            cartão.
          </Text>
        </>
      ) : (
        (frequency === 'monthly' || frequency === 'manual') && (
          <Field
            label="Dia previsto"
            value={day}
            numeric
            onChange={setDay}
            hint="1 a 31"
          />
        )
      )}
      <Field label="Observações" value={notes} multiline onChange={setNotes} />
      {item && (
        <Text style={styles.muted}>
          A edição atualiza previsões abertas. Valores realizados e histórico
          concluído são preservados. Pausar impede novas ocorrências.
        </Text>
      )}
    </Editor>
  );
}
export function InstallmentEditor({
  item,
  catalogs,
  month,
  onClose,
  onSave,
}: {
  item: (InstallmentPurchase & { paymentMethodId: string | null }) | null;
  catalogs: Catalogs;
  month: string;
  onClose: () => void;
  onSave: (input: InstallmentPurchaseInput) => Promise<void>;
}) {
  const styles = useStyles();
  const [description, setDescription] = useState(item?.description ?? '');
  const [amount, setAmount] = useState(
    String(item?.installmentAmount ?? '').replace('.', ','),
  );
  const [total, setTotal] = useState(String(item?.totalInstallments ?? 12));
  const [current, setCurrent] = useState(String(item?.viewedInstallment ?? 1));
  const [date, setDate] = useState(item?.viewedDueDate ?? `${month}-10`);
  const [purchase, setPurchase] = useState(item?.purchaseDate ?? `${month}-01`);
  const [category, setCategory] = useState(item?.categoryId ?? '');
  const [payment, setPayment] = useState(item?.paymentMethodId ?? '');
  const [card, setCard] = useState(item?.cardId ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const suggestDue = (cardId: string, purchaseDate: string) => {
    const c = catalogs.cards.find((v) => v.id === cardId);
    if (c && isValidDate(purchaseDate))
      setDate(
        c.closingDay == null
          ? nextCardDueDate(purchaseDate, c.dueDay)
          : cardStatementDueDate(purchaseDate, c.closingDay, c.dueDay),
      );
  };
  return (
    <Editor
      title={item ? 'Editar parcelamento' : 'Nova compra parcelada'}
      onClose={onClose}
      onSave={() =>
        onSave({
          id: item?.id,
          description,
          installmentAmount: parseMoney(amount),
          totalInstallments: Number(total),
          currentInstallment: Number(current),
          originalCurrentInstallment: item?.viewedInstallment,
          currentDueDate: date,
          purchaseDate: purchase || null,
          categoryId: category || null,
          paymentMethodId: payment || null,
          cardId: card || null,
          notes,
        })
      }
    >
      <Field label="Descrição" value={description} onChange={setDescription} />
      <Field
        label="Valor por parcela"
        value={amount}
        numeric
        onChange={setAmount}
      />
      <Field
        label="Total de parcelas"
        value={total}
        numeric
        onChange={setTotal}
      />
      <Field
        label="Parcela atual"
        value={current}
        numeric
        onChange={setCurrent}
      />
      <References
        catalogs={catalogs}
        kind="expense"
        categoryId={category}
        setCategory={setCategory}
        paymentId={payment}
        setPayment={setPayment}
        cardId={card}
        setCard={(v) => {
          setCard(v);
          if (!item) suggestDue(v, purchase);
        }}
      />
      <DateField
        label="Data da compra"
        value={purchase}
        onChange={(v) => {
          setPurchase(v);
          if (!item) suggestDue(card, v);
        }}
        optional
      />
      <DateField
        label="Vencimento da parcela atual"
        value={date}
        onChange={setDate}
        hint="AAAA-MM-DD; pode ajustar a sugestão da fatura"
      />
      <Text style={styles.muted}>
        {item
          ? 'Corrigir a parcela atual renumera a série. Parcelas concluídas mantêm valor e vencimento.'
          : 'Parcelas anteriores à atual contam como já pagas. Da atual até a última, os lançamentos são criados mês a mês.'}
      </Text>
      <Field label="Observações" value={notes} multiline onChange={setNotes} />
    </Editor>
  );
}
export const goalStatuses = [
  { value: 'planned', label: 'Planejado' },
  { value: 'saving', label: 'Guardando' },
  { value: 'completed', label: 'Concluído' },
  { value: 'paused', label: 'Pausado' },
  { value: 'cancelled', label: 'Cancelado' },
];
export function GoalEditor({
  item,
  catalogs,
  onClose,
  onSave,
}: {
  item: Goal | null;
  catalogs: Catalogs;
  onClose: () => void;
  onSave: (input: GoalInput) => Promise<void>;
}) {
  const styles = useStyles();
  const [name, setName] = useState(item?.name ?? ''),
    [model, setModel] = useState(item?.itemModel ?? '');
  const [link, setLink] = useState(item?.link ?? ''),
    [category, setCategory] = useState(item?.categoryId ?? '');
  const [target, setTarget] = useState(
    String(item?.targetAmount ?? '').replace('.', ','),
  );
  const [saved, setSaved] = useState(
    String(item?.savedAmount ?? 0).replace('.', ','),
  );
  const [priority, setPriority] = useState(item?.priority ?? 'medium'),
    [status, setStatus] = useState(item?.status ?? 'planned');
  const [date, setDate] = useState(item?.dueDate ?? ''),
    [notes, setNotes] = useState(item?.notes ?? '');
  return (
    <Editor
      title={item ? 'Editar objetivo' : 'Novo objetivo'}
      onClose={onClose}
      onSave={() =>
        onSave({
          id: item?.id,
          name,
          itemModel: model,
          link: link.trim() ? externalGoalUrl(link) : '',
          categoryId: category || null,
          targetAmount: parseMoney(target, true),
          savedAmount: parseMoney(saved, true),
          priority,
          status,
          dueDate: date || null,
          notes,
        })
      }
    >
      <Field label="Nome" value={name} onChange={setName} />
      <Field label="Valor alvo" value={target} numeric onChange={setTarget} />
      <Field label="Valor guardado" value={saved} numeric onChange={setSaved} />
      <Text style={styles.muted}>
        O valor guardado acompanha o objetivo; não cria um lançamento de entrada
        ou saída.
      </Text>
      <Choice
        label="Situação"
        value={status}
        options={goalStatuses}
        onChange={(v) => setStatus(v as typeof status)}
      />
      <Choice
        label="Prioridade"
        value={priority}
        onChange={(v) => setPriority(v as typeof priority)}
        options={[
          { value: 'high', label: 'Alta' },
          { value: 'medium', label: 'Média' },
          { value: 'low', label: 'Baixa' },
        ]}
      />
      <DateField label="Prazo" value={date} onChange={setDate} optional />
      <Choice
        label="Categoria"
        value={category}
        onChange={setCategory}
        options={[
          { value: '', label: 'Sem categoria' },
          ...catalogs.categories
            .filter((c) => c.kind === 'expense' || c.id === category)
            .map((c) => ({ value: c.id, label: c.name })),
        ]}
      />
      <Field label="Modelo ou item" value={model} onChange={setModel} />
      <Field label="Link" value={link} onChange={setLink} />
      <Field label="Observações" value={notes} multiline onChange={setNotes} />
    </Editor>
  );
}

export function SafetyMarginEditor({ month, cents, onClose, onSave }: {
  month: string; cents: number; onClose: () => void; onSave: (cents: number) => Promise<void>;
}) {
  const styles = useStyles();
  const [value, setValue] = useState(cents ? String(cents / 100).replace('.', ',') : '');
  const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`));
  return <Editor title="Margem de segurança" onClose={onClose}
    onSave={() => onSave(safetyMarginToCents(parseMoney(value, true)))}
    onRemove={cents > 0 ? () => onSave(0) : undefined}>
    <Text style={styles.heading}>{label}</Text>
    <Text style={styles.muted}>Reserve uma parte do saldo para imprevistos. Esse valor não cria nenhuma despesa e vale somente para este mês.</Text>
    {cents > 0 && <Text style={styles.muted}>Margem atual: {money(cents / 100)}</Text>}
    <Field label="Margem de segurança (R$)" value={value} onChange={setValue} numeric />
  </Editor>;
}
