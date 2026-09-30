import React, { useEffect, useRef, useState } from 'react';
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
  isCreditCardPaymentMethodName,
  isValidDate,
  nextCardDueDate,
  settlementDateFor,
  statusForDate,
  todayIso,
  validateTransaction,
} from '@lionpocket/core';
import type {
  Catalogs,
  MoneyKind,
  Transaction,
  TransactionInput,
  TransactionStatus,
  TransactionSuggestion,
} from '@lionpocket/core';
import { suggestTransactions } from '../db/transactions';
import { parseMoney } from '../transactionForm';
import {
  Button,
  Choice,
  DateField,
  Field,
  ScreenHeader,
  useStyles,
} from './components';

export function TransactionEditor({
  item,
  defaultDate,
  catalogs,
  onClose,
  onSave,
}: {
  item: Transaction | null;
  defaultDate: string;
  catalogs: Catalogs;
  onClose: () => void;
  onSave: (input: TransactionInput, keepOpen?: boolean) => Promise<void>;
}) {
  const styles = useStyles();
  const [kind, setKind] = useState<MoneyKind>(item?.kind ?? 'expense');
  const [description, setDescription] = useState(item?.description ?? '');
  const [planned, setPlanned] = useState(
    String(item?.plannedAmount ?? '').replace('.', ','),
  );
  const [actual, setActual] = useState(
    item?.actualAmount == null
      ? ''
      : String(item.actualAmount).replace('.', ','),
  );
  const [dueDate, setDueDate] = useState(item?.dueDate ?? defaultDate);
  const [settledDate, setSettledDate] = useState(
    item?.settledDate ?? settlementDateFor(defaultDate),
  );
  const [status, setStatus] = useState<TransactionStatus>(
    item?.status ?? statusForDate(defaultDate, item?.kind ?? 'expense'),
  );
  const [statusChosen, setStatusChosen] = useState(Boolean(item));
  const [amountsLinked, setAmountsLinked] = useState(
    !item ||
      item.actualAmount == null ||
      item.actualAmount === item.plannedAmount,
  );
  const [savedCount, setSavedCount] = useState(0);
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(
    item?.paymentMethodId ?? '',
  );
  const [cardId, setCardId] = useState(item?.cardId ?? '');
  const [purchaseDate, setPurchaseDate] = useState(
    item ? (item.purchaseDate ?? '') : todayIso(),
  );
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const appliedSuggestion = useRef('');
  const [suggestions, setSuggestions] = useState<TransactionSuggestion[]>([]);
  const [suggestionError, setSuggestionError] = useState('');
  useEffect(() => {
    let active = true;
    setSuggestions([]);
    setSuggestionError('');
    if (
      item ||
      description.trim().length < 2 ||
      description === appliedSuggestion.current
    )
      return;
    const timer = setTimeout(() => {
      void suggestTransactions(kind, description)
        .then((result) => {
          if (active) setSuggestions(result);
        })
        .catch(() => {
          if (active)
            setSuggestionError(
              'Não foi possível consultar o histórico. Você pode continuar preenchendo.',
            );
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [description, kind, item]);
  const settled = status === 'paid' || status === 'received';
  const creditMethod = catalogs.paymentMethods.find((p) =>
    isCreditCardPaymentMethodName(p.name),
  );
  const credit = Boolean(cardId) || paymentMethodId === creditMethod?.id;
  const applyDueDate = (value: string) => {
    setDueDate(value);
    if (!statusChosen) {
      const next = statusForDate(value, kind);
      setStatus(next);
      if (amountsLinked) setActual(next === 'planned' ? '' : planned);
    }
    if (!item?.settledDate && isValidDate(value))
      setSettledDate(item?.isOverdue ? todayIso() : settlementDateFor(value));
  };
  const calculateDue = (id: string, date: string) => {
    const card = catalogs.cards.find((c) => c.id === id);
    if (card && isValidDate(date)) {
      applyDueDate(
        card.closingDay == null
          ? nextCardDueDate(date, card.dueDay)
          : cardStatementDueDate(date, card.closingDay, card.dueDay),
      );
    }
  };
  const save = async (keepOpen = false) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const input: TransactionInput = {
        id: item?.id,
        kind,
        description: description.trim(),
        plannedAmount: parseMoney(planned, true),
        actualAmount: actual ? parseMoney(actual, true) : null,
        dueDate,
        status,
        settledDate: settled ? settledDate : null,
        categoryId: categoryId || null,
        paymentMethodId: paymentMethodId || null,
        cardId: kind === 'expense' ? cardId || null : null,
        purchaseDate: cardId ? purchaseDate || null : null,
        notes,
      };
      validateTransaction(input, catalogs);
      Keyboard.dismiss();
      await onSave(input, keepOpen);
      if (keepOpen) {
        setSavedCount((count) => count + 1);
        setDescription('');
        setPlanned('');
        setActual('');
        setNotes('');
        setAmountsLinked(true);
        setSuggestions([]);
        appliedSuggestion.current = '';
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível salvar.',
      );
    } finally {
      saving.current = false;
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
          <ScreenHeader
            title={item ? 'Editar lançamento' : 'Novo lançamento'}
            subtitle={
              savedCount
                ? `${savedCount} lançamento(s) salvo(s)`
                : !item &&
                    statusForDate(dueDate, kind) !== 'planned' &&
                    !statusChosen
                  ? 'Data anterior a hoje: realização sugerida automaticamente.'
                  : undefined
            }
            onClose={onClose}
            disabled={busy}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            <Choice
              inline
              label="Tipo"
              value={kind}
              options={[
                { value: 'expense', label: 'Saída' },
                { value: 'income', label: 'Entrada' },
              ]}
              onChange={(value) => {
                const next = value as MoneyKind;
                setKind(next);
                setCategoryId('');
                if (next === 'income') {
                  setCardId('');
                  setPaymentMethodId('');
                }
                if (!statusChosen) setStatus(statusForDate(dueDate, next));
                else if (settled)
                  setStatus(next === 'income' ? 'received' : 'paid');
              }}
            />
            <Field
              label="Descrição"
              value={description}
              onChange={(value) => {
                appliedSuggestion.current = '';
                setDescription(value);
              }}
            />
            {suggestions.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.label}>Sugestões do histórico</Text>
                {suggestions.map((s) => (
                  <Button
                    key={s.description}
                    label={`${s.description} · ${s.uses} uso(s)`}
                    disabled={busy}
                    onPress={() => {
                      Keyboard.dismiss();
                      appliedSuggestion.current = s.description;
                      setDescription(s.description);
                      if (!categoryId) setCategoryId(s.categoryId ?? '');
                      if (!paymentMethodId && kind === 'expense')
                        setPaymentMethodId(s.paymentMethodId ?? '');
                      if (!cardId && s.cardId && kind === 'expense') {
                        setCardId(s.cardId);
                        if (creditMethod) setPaymentMethodId(creditMethod.id);
                        calculateDue(s.cardId, purchaseDate);
                      }
                      if (!planned && s.amount > 0) {
                        const amount = String(s.amount).replace('.', ',');
                        setPlanned(amount);
                        if (settled && amountsLinked) setActual(amount);
                      }
                      setSuggestions([]);
                    }}
                  />
                ))}
              </View>
            )}
            {suggestionError ? (
              <Text style={styles.muted}>{suggestionError}</Text>
            ) : null}
            <Field
              prominent
              label="Valor planejado"
              value={planned}
              numeric
              onChange={(value) => {
                setPlanned(value);
                if (amountsLinked && settled) setActual(value);
              }}
              hint="Ex.: 125,50"
            />
            <Choice
              label="Categoria"
              value={categoryId}
              options={[
                { value: '', label: 'Sem categoria' },
                ...catalogs.categories
                  .filter((c) => c.kind === kind)
                  .map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={setCategoryId}
            />
            <Choice
              label="Forma de pagamento"
              value={paymentMethodId}
              options={[
                { value: '', label: 'Não informada' },
                ...catalogs.paymentMethods.map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
              ]}
              onChange={(value) => {
                setPaymentMethodId(value);
                if (value !== creditMethod?.id) setCardId('');
                else {
                  const id = cardId || catalogs.cards[0]?.id;
                  if (id) {
                    setCardId(id);
                    calculateDue(id, purchaseDate);
                  }
                }
              }}
            />
            {kind === 'expense' && credit && (
              <>
                <Choice
                  label="Cartão"
                  value={cardId}
                  options={[
                    { value: '', label: 'Sem cartão' },
                    ...catalogs.cards.map((c) => ({
                      value: c.id,
                      label: c.name,
                    })),
                  ]}
                  onChange={(value) => {
                    setCardId(value);
                    if (value && creditMethod)
                      setPaymentMethodId(creditMethod.id);
                    calculateDue(value, purchaseDate);
                  }}
                />
                {catalogs.cards.length === 0 && (
                  <Text style={styles.muted}>
                    Cadastre seu cartão em Cadastros na tela mensal.
                  </Text>
                )}
                {cardId && (
                  <DateField
                    label="Data da compra"
                    value={purchaseDate}
                    onChange={(value) => {
                      setPurchaseDate(value);
                      calculateDue(cardId, value);
                    }}
                  />
                )}
                {cardId && (
                  <Text style={styles.muted}>
                    O vencimento é sugerido pelo fechamento e pode ser ajustado.
                  </Text>
                )}
              </>
            )}
            <DateField
              label="Data prevista / vencimento"
              value={dueDate}
              onChange={applyDueDate}
            />
            <Choice
              inline
              label="Situação"
              value={status}
              options={[
                { value: 'planned', label: 'Planejado' },
                {
                  value: kind === 'income' ? 'received' : 'paid',
                  label: kind === 'income' ? 'Recebido' : 'Pago',
                },
                { value: 'cancelled', label: 'Cancelado' },
              ]}
              onChange={(value) => {
                setStatus(value as TransactionStatus);
                setStatusChosen(true);
                if (amountsLinked)
                  setActual(
                    value === 'paid' || value === 'received' ? planned : '',
                  );
                if (value === 'paid' || value === 'received') {
                  if (!item?.settledDate)
                    setSettledDate(
                      item?.isOverdue ? todayIso() : settlementDateFor(dueDate),
                    );
                }
              }}
            />
            <Field
              label="Valor realizado"
              value={actual}
              numeric
              onChange={(value) => {
                setActual(value);
                if (!planned) {
                  setPlanned(value);
                  setAmountsLinked(true);
                } else setAmountsLinked(value === planned);
              }}
              hint={
                settled
                  ? 'Em branco usa o valor planejado'
                  : 'Opcional enquanto planejado'
              }
            />
            {settled && (
              <DateField
                label={
                  kind === 'income'
                    ? 'Data do recebimento'
                    : 'Data do pagamento'
                }
                value={settledDate}
                onChange={setSettledDate}
              />
            )}
            <Field
              label="Observações"
              value={notes}
              multiline
              onChange={setNotes}
            />
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
          </ScrollView>
          <View style={[styles.formFooter, { gap: 8 }]}>
            {!item && (
              <Button
                label="Salvar e adicionar outro"
                disabled={busy}
                onPress={() => void save(true)}
              />
            )}
            <Button
              label={busy ? 'Salvando…' : 'Salvar lançamento'}
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
