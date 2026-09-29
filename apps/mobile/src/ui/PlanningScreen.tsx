import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { addMonths } from '@lionpocket/core';
import type { Catalogs, Goal, InstallmentPurchase, RecurringExpense } from '@lionpocket/core';
import {
  deleteGoal,
  deleteInstallment,
  deleteRecurring,
  listGoals,
  listInstallments,
  listRecurring,
  saveGoal,
  saveInstallment,
  saveRecurring,
} from '../db/transactions';
import { Button, dateLabel, money, styles } from './components';
import {
  frequencies,
  GoalEditor,
  goalStatuses,
  InstallmentEditor,
  RecurringEditor,
} from './PlanningEditors';

export type PlanningArea = 'recurring' | 'installments' | 'goals';
type Purchase = InstallmentPurchase & { paymentMethodId: string | null };
const titles = { recurring: 'Recorrências', installments: 'Parcelamentos', goals: 'Objetivos' };
const statusLabel = {
  planned: 'Planejado',
  paid: 'Pago',
  received: 'Recebido',
  cancelled: 'Cancelado',
};

export function PlanningScreen({
  area,
  catalogs,
  month,
  onMonth,
  onClose,
  onChanged,
}: {
  area: PlanningArea;
  catalogs: Catalogs;
  month: string;
  onMonth: (month: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [recurring, setRecurring] = useState<RecurringExpense[]>([]),
    [purchases, setPurchases] = useState<Purchase[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]),
    [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [editor, setEditor] = useState<RecurringExpense | Purchase | Goal | 'new' | null>(null);
  const pending = useRef(false),
    revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const values =
        area === 'recurring'
          ? await listRecurring()
          : area === 'installments'
            ? await listInstallments(month)
            : await listGoals();
      if (revision.current !== request) return;
      if (area === 'recurring') setRecurring(values as RecurringExpense[]);
      else if (area === 'installments') setPurchases(values as Purchase[]);
      else setGoals(values as Goal[]);
    } catch (cause) {
      if (request === revision.current)
        setError(cause instanceof Error ? cause.message : 'Falha ao carregar.');
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [area, month]);
  useEffect(() => {
    void load();
    return () => {
      ++revision.current;
    };
  }, [load]);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setEditor(null);
      await onChanged();
      await load();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const act = (action: () => Promise<void>) => {
    void run(action).catch((cause) =>
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar.'),
    );
  };
  const remove = (id: string, name: string) =>
    Alert.alert(
      `Excluir ${area === 'goals' ? 'objetivo' : area === 'recurring' ? 'recorrência' : 'compra parcelada'}?`,
      `${name}. ${
        area === 'recurring'
          ? 'Os lançamentos existentes serão preservados; novas ocorrências deixarão de ser geradas.'
          : area === 'installments'
            ? 'As parcelas pendentes serão removidas. Parcelas concluídas permanecem no histórico.'
            : 'O objetivo será removido da lista.'
      }`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: () =>
            act(() =>
              area === 'recurring'
                ? deleteRecurring(id)
                : area === 'installments'
                  ? deleteInstallment(id)
                  : deleteGoal(id),
            ),
        },
      ],
    );
  const items: Array<RecurringExpense | Purchase | Goal> =
    area === 'recurring' ? recurring : area === 'installments' ? purchases : goals;
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <FlatList
          data={loading ? [] : items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshing={loading}
          onRefresh={() => {
            if (!busy) void load();
          }}
          ListHeaderComponent={
            <View style={styles.content}>
              <View style={styles.row}>
                <Text style={[styles.title, { flex: 1 }]}>{titles[area]}</Text>
                <Button label="Fechar" disabled={busy} onPress={onClose} />
              </View>
              {area === 'installments' && (
                <>
                  <Text style={styles.heading}>{month.split('-').reverse().join('/')}</Text>
                  <View style={styles.row}>
                    <Button
                      label="Mês anterior"
                      disabled={busy || month === '1000-01'}
                      onPress={() => onMonth(addMonths(`${month}-01`, -1).slice(0, 7))}
                    />
                    <Button
                      label="Próximo mês"
                      disabled={busy || month === '9999-12'}
                      onPress={() => onMonth(addMonths(`${month}-01`, 1).slice(0, 7))}
                    />
                  </View>
                </>
              )}
              <Text style={styles.muted}>
                {area === 'recurring'
                  ? 'Planeje entradas e saídas que se repetem. Os lançamentos aparecem ao consultar cada mês.'
                  : area === 'installments'
                    ? 'Acompanhe a parcela deste mês e os pagamentos da compra.'
                    : 'Acompanhe quanto falta e ajuste o valor guardado.'}
              </Text>
              <Button
                label={
                  area === 'recurring'
                    ? 'Nova recorrência'
                    : area === 'installments'
                      ? 'Nova compra parcelada'
                      : 'Novo objetivo'
                }
                tone="primary"
                disabled={busy || loading}
                onPress={() => setEditor('new')}
              />
              {loading && <ActivityIndicator color="#b9adff" />}
              {error ? (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {error}
                  </Text>
                  <Button label="Tentar novamente" disabled={busy} onPress={() => void load()} />
                </>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            !loading && !error ? (
              <Text style={[styles.muted, { padding: 20 }]}>
                {area === 'installments'
                  ? 'Nenhuma parcela neste mês. Mude o mês ou adicione uma compra.'
                  : 'Nenhum item cadastrado.'}
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { marginHorizontal: 20, marginBottom: 12 }]}>
              {'startMonth' in item ? (
                <>
                  <Text style={styles.heading}>{item.description}</Text>
                  <Text style={item.kind === 'income' ? styles.positive : styles.danger}>
                    {item.kind === 'income' ? 'Entrada' : 'Saída'} · {money(item.plannedAmount)}
                  </Text>
                  <Text style={styles.text}>
                    {item.active ? 'Ativa' : 'Pausada'} ·{' '}
                    {frequencies.find((f) => f.value === item.frequency)?.label}
                  </Text>
                  <Text style={styles.muted}>
                    Desde {item.startMonth}
                    {item.frequency !== 'manual' ? ` · ${dateLabel(item.startDate)}` : ''}
                    {item.frequency === 'custom'
                      ? ` · a cada ${item.intervalCount} ${{ days: 'dias', weeks: 'semanas', months: 'meses', years: 'anos' }[item.intervalUnit]}`
                      : ''}
                  </Text>
                  {item.frequency === 'manual' && (
                    <Text style={styles.muted}>Meses: {item.manualMonths.join(', ')}</Text>
                  )}
                  {item.cardName && (
                    <Text style={styles.muted}>
                      {item.cardName} · cobrança {item.chargeDay ?? 'pela data'} · fatura conforme
                      fechamento
                    </Text>
                  )}
                  <Text style={styles.muted}>
                    {[item.categoryName, item.paymentMethodName].filter(Boolean).join(' · ')}
                  </Text>
                  {item.notes ? <Text style={styles.muted}>{item.notes}</Text> : null}
                  <Button
                    label={item.active ? 'Pausar' : 'Reativar'}
                    disabled={busy}
                    onPress={() => act(() => saveRecurring({ ...item, active: !item.active }))}
                  />
                </>
              ) : 'viewedInstallment' in item ? (
                <>
                  <Text style={styles.heading}>{item.description}</Text>
                  <Text style={styles.text}>{money(item.installmentAmount)} por parcela</Text>
                  <Text style={styles.text}>
                    Parcela {item.viewedInstallment} de {item.totalInstallments} ·{' '}
                    {statusLabel[item.viewedStatus]}
                  </Text>
                  <Text style={styles.muted}>
                    {dateLabel(item.viewedDueDate)} · {item.cardName ?? 'Sem cartão'}
                  </Text>
                  <Progress
                    value={item.viewedInstallment / item.totalInstallments}
                    label={`Parcela ${item.viewedInstallment} de ${item.totalInstallments}`}
                  />
                  <Text style={styles.muted}>
                    {item.paidInstallments} pagas até este mês ·{' '}
                    {Math.max(0, item.totalInstallments - item.viewedInstallment)} restantes após
                    este mês
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.heading}>{item.name}</Text>
                  <Text style={styles.text}>
                    {goalStatuses.find((s) => s.value === item.status)?.label} · Prioridade{' '}
                    {{ high: 'alta', medium: 'média', low: 'baixa' }[item.priority]}
                  </Text>
                  <Text style={styles.positive}>
                    {money(item.savedAmount)} de {money(item.targetAmount)}
                  </Text>
                  <Progress
                    value={item.progress}
                    label={`${Math.round(item.progress * 100)}% guardado`}
                  />
                  <Text style={styles.text}>Faltam {money(item.remainingAmount)}</Text>
                  {item.suggestedMonthlyAmount != null && (
                    <Text style={styles.muted}>
                      Sugestão mensal: {money(item.suggestedMonthlyAmount)}
                    </Text>
                  )}
                  {item.dueDate && (
                    <Text style={styles.muted}>Prazo: {dateLabel(item.dueDate)}</Text>
                  )}
                  {item.itemModel ? <Text style={styles.muted}>{item.itemModel}</Text> : null}
                  {item.link ? (
                    <Text selectable style={styles.muted}>
                      {item.link}
                    </Text>
                  ) : null}
                  {item.notes ? <Text style={styles.muted}>{item.notes}</Text> : null}
                </>
              )}
              <View style={styles.row}>
                <Button label="Editar" disabled={busy} onPress={() => setEditor(item)} />
                <Button
                  label="Excluir"
                  tone="danger"
                  disabled={busy}
                  onPress={() => remove(item.id, 'name' in item ? item.name : item.description)}
                />
              </View>
            </View>
          )}
        />
        {editor &&
          (area === 'recurring' ? (
            <RecurringEditor
              item={editor === 'new' ? null : (editor as RecurringExpense)}
              month={month}
              catalogs={catalogs}
              onClose={() => setEditor(null)}
              onSave={(input) => run(() => saveRecurring(input))}
            />
          ) : area === 'installments' ? (
            <InstallmentEditor
              item={editor === 'new' ? null : (editor as Purchase)}
              month={month}
              catalogs={catalogs}
              onClose={() => setEditor(null)}
              onSave={async (input) => {
                await run(() => saveInstallment(input));
                if (!input.id) onMonth(input.currentDueDate.slice(0, 7));
              }}
            />
          ) : (
            <GoalEditor
              item={editor === 'new' ? null : (editor as Goal)}
              catalogs={catalogs}
              onClose={() => setEditor(null)}
              onSave={(input) => run(() => saveGoal(input))}
            />
          ))}
      </SafeAreaView>
    </Modal>
  );
}
function Progress({ value, label }: { value: number; label: string }) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={{ height: 8, borderRadius: 4, backgroundColor: '#343e53', overflow: 'hidden' }}
    >
      <View
        style={{
          height: 8,
          width: `${Math.min(100, Math.max(0, value * 100))}%`,
          backgroundColor: '#a99bf9',
        }}
      />
    </View>
  );
}
