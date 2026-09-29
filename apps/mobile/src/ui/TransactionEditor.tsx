import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  cardStatementDueDate,
  isCreditCardPaymentMethodName,
  isValidDate,
  nextCardDueDate,
  settlementDateFor,
  todayIso,
  validateTransaction,
} from '@lionpocket/core';
import type {
  Catalogs,
  MoneyKind,
  Transaction,
  TransactionInput,
  TransactionStatus,
} from '@lionpocket/core';
import { parseMoney } from '../transactionForm';
import { Button, Choice, Field, styles } from './components';

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
  onSave: (input: TransactionInput) => Promise<void>;
}) {
  const [kind, setKind] = useState<MoneyKind>(item?.kind ?? 'expense');
  const [description, setDescription] = useState(item?.description ?? '');
  const [planned, setPlanned] = useState(String(item?.plannedAmount ?? '').replace('.', ','));
  const [actual, setActual] = useState(
    item?.actualAmount == null ? '' : String(item.actualAmount).replace('.', ','),
  );
  const [dueDate, setDueDate] = useState(item?.dueDate ?? defaultDate);
  const [settledDate, setSettledDate] = useState(
    item?.settledDate ?? settlementDateFor(defaultDate),
  );
  const [status, setStatus] = useState<TransactionStatus>(item?.status ?? 'planned');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [paymentMethodId, setPaymentMethodId] = useState(item?.paymentMethodId ?? '');
  const [cardId, setCardId] = useState(item?.cardId ?? '');
  const [purchaseDate, setPurchaseDate] = useState(item?.purchaseDate ?? todayIso());
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const settled = status === 'paid' || status === 'received';
  const creditMethod = catalogs.paymentMethods.find((p) => isCreditCardPaymentMethodName(p.name));
  const credit = Boolean(cardId) || paymentMethodId === creditMethod?.id;
  const calculateDue = (id: string, date: string) => {
    const card = catalogs.cards.find((c) => c.id === id);
    if (card && isValidDate(date)) {
      setDueDate(
        card.closingDay == null
          ? nextCardDueDate(date, card.dueDay)
          : cardStatementDueDate(date, card.closingDay, card.dueDay),
      );
    }
  };
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const input: TransactionInput = {
        id: item?.id,
        kind,
        description: description.trim(),
        plannedAmount: parseMoney(planned),
        actualAmount: settled
          ? parseMoney(actual || planned, true)
          : actual
            ? parseMoney(actual, true)
            : null,
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
      await onSave(input);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.');
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
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <View style={styles.row}>
              <Text style={[styles.heading, { flex: 1 }]}>
                {item ? 'Editar lançamento' : 'Novo lançamento'}
              </Text>
              <Button label="Fechar" disabled={busy} onPress={onClose} />
            </View>
            <Choice
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
                if (settled) setStatus(next === 'income' ? 'received' : 'paid');
              }}
            />
            <Field label="Descrição" value={description} onChange={setDescription} />
            <Field
              label="Valor planejado"
              value={planned}
              numeric
              onChange={(value) => {
                setPlanned(value);
                if (actual === planned) setActual(value);
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
                    calculateDue(value, purchaseDate);
                  }}
                />
                {catalogs.cards.length === 0 && (
                  <Text style={styles.muted}>Cadastre seu cartão em Cadastros na tela mensal.</Text>
                )}
                {cardId && (
                  <Field
                    label="Data da compra"
                    value={purchaseDate}
                    onChange={(value) => {
                      setPurchaseDate(value);
                      calculateDue(cardId, value);
                    }}
                    hint="AAAA-MM-DD"
                  />
                )}
                {cardId && (
                  <Text style={styles.muted}>
                    O vencimento é sugerido pelo fechamento e pode ser ajustado.
                  </Text>
                )}
              </>
            )}
            <Field
              label="Data prevista / vencimento"
              value={dueDate}
              onChange={(value) => {
                setDueDate(value);
                if (!item && !settled)
                  setSettledDate(isValidDate(value) ? settlementDateFor(value) : value);
              }}
              hint="AAAA-MM-DD"
            />
            <Choice
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
                if (value === 'paid' || value === 'received') {
                  if (!actual) setActual(planned);
                  if (!item?.settledDate)
                    setSettledDate(item?.isOverdue ? todayIso() : settlementDateFor(dueDate));
                }
              }}
            />
            <Field
              label="Valor realizado"
              value={actual}
              numeric
              onChange={setActual}
              hint={settled ? 'Em branco usa o valor planejado' : 'Opcional enquanto planejado'}
            />
            {settled && (
              <Field
                label={kind === 'income' ? 'Data do recebimento' : 'Data do pagamento'}
                value={settledDate}
                onChange={setSettledDate}
                hint="AAAA-MM-DD"
              />
            )}
            <Field label="Observações" value={notes} multiline onChange={setNotes} />
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            <Button
              label={busy ? 'Salvando…' : 'Salvar lançamento'}
              tone="primary"
              disabled={busy}
              onPress={() => void save()}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
