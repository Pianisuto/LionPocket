import { protectionLine } from './planningPresentation';
import { FreeNowSummary } from './FreeNowSummary';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  upcomingPayments,
  type MonthlyOverview,
  type Transaction,
} from '@lionpocket/core';
import { getMonthlyOverview } from '../db/transactions';
import {
  Button,
  ScreenHeader,
  dateLabel,
  money,
  useStyles,
} from './components';
import { useAppearance } from './Appearance';

export function OverviewScreen({
  month,
  onClose,
  onEdit,
  onSettle,
  onGoals,
  onAnnual,
  onTransactions,
}: {
  month: string;
  onClose: () => void;
  onEdit: (item: Transaction) => void;
  onSettle: (items: Transaction[]) => Promise<void>;
  onGoals: () => void;
  onAnnual: () => void;
  onTransactions: () => void;
}) {
  const styles = useStyles(),
    { colors } = useAppearance();
  const [overview, setOverview] = useState<MonthlyOverview | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef(false),
    revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setError('');
    setOverview(null);
    try {
      const data = await getMonthlyOverview(month);
      if (request === revision.current) setOverview(data);
    } catch (cause) {
      if (request === revision.current)
        setError(
          cause instanceof Error ? cause.message : 'Falha ao carregar o mês.',
        );
    }
  }, [month]);
  useEffect(() => {
    void load();
    return () => {
      ++revision.current;
    };
  }, [load]);
  const settle = async (items: Transaction[]) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await onSettle(items);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao concluir.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const summary = overview?.summary;
  const total =
    overview?.categoryBreakdown.reduce((sum, c) => sum + c.amount, 0) ?? 0;
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <SafeAreaView style={styles.safe}>
        <ScreenHeader
          title="Visão geral"
          subtitle={new Intl.DateTimeFormat('pt-BR', {
            month: 'long',
            year: 'numeric',
          }).format(new Date(`${month}-15T12:00:00`))}
          disabled={busy}
          onClose={onClose}
        />
        <ScrollView contentContainerStyle={styles.content}>
          {!!error && (
            <View style={styles.card}>
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
              <Button label="Tentar novamente" onPress={() => void load()} />
            </View>
          )}
          {!overview && !error && <ActivityIndicator color={colors.primary} />}
          {overview && summary && (
            <>
              <View style={styles.card}>
                <Text style={styles.label}>Saldo projetado</Text>
                <Text
                  style={[
                    styles.title,
                    {
                      color:
                        summary.projectedBalance < 0
                          ? colors.alert
                          : colors.primaryInk,
                    },
                  ]}
                >
                  {money(summary.projectedBalance)}
                </Text>
                {protectionLine(overview.protection) && <Text style={protectionLine(overview.protection)!.negative ? styles.danger : styles.muted}>{protectionLine(overview.protection)!.text}</Text>}
                <FreeNowSummary freeNow={overview.freeNow} />
                <Text style={styles.muted}>
                  Realizado: {money(summary.realizedBalance)}
                </Text>
                <Text style={styles.text}>
                  Entradas planejadas · {money(summary.plannedIncome)}
                </Text>
                <Text style={styles.muted}>
                  {money(summary.receivedIncome)} recebidos
                </Text>
                <Text style={styles.text}>
                  Saídas planejadas · {money(summary.plannedExpenses)}
                </Text>
                <Text style={styles.muted}>
                  {money(summary.paidExpenses)} pagos
                </Text>
                <Text style={styles.label}>
                  Renda comprometida ·{' '}
                  {Math.round(summary.committedPercent * 100)}%
                </Text>
                <View
                  style={{
                    height: 6,
                    backgroundColor: colors.surface3,
                    borderRadius: 3,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: 6,
                      width: `${Math.min(100, Math.max(0, summary.committedPercent * 100))}%`,
                      backgroundColor:
                        summary.committedPercent > 0.85
                          ? colors.alert
                          : colors.primary,
                    }}
                  />
                </View>
                {summary.overdueExpenses > 0 && (
                  <Text style={styles.error}>
                    {money(summary.overdueExpenses)} em atraso
                  </Text>
                )}
              </View>
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  Saídas por categoria
                </Text>
                <Text style={styles.muted}>
                  Realizado nas saídas pagas; planejado nas pendentes.
                </Text>
                {overview.categoryBreakdown.length === 0 && (
                  <Text style={styles.muted}>Sem saídas neste mês.</Text>
                )}
                {overview.categoryBreakdown.map((c) => (
                  <Pressable
                    key={c.name}
                    accessibilityRole="button"
                    accessibilityLabel={`${c.name}, ${money(c.amount)}, ${Math.round((c.amount / total) * 100)}% das saídas`}
                    accessibilityState={{
                      selected: selectedCategory === c.name,
                    }}
                    onPress={() =>
                      setSelectedCategory(
                        selectedCategory === c.name ? null : c.name,
                      )
                    }
                    style={{ gap: 8, paddingVertical: 8 }}
                  >
                    <View style={styles.row}>
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: c.color,
                        }}
                      />
                      <Text style={[styles.text, { flex: 1 }]}>{c.name}</Text>
                      <Text style={styles.label}>{money(c.amount)}</Text>
                    </View>
                    <View
                      style={{
                        height: selectedCategory === c.name ? 8 : 4,
                        backgroundColor: colors.surface3,
                        borderRadius: 4,
                      }}
                    >
                      <View
                        style={{
                          height: '100%',
                          width: `${(c.amount / total) * 100}%`,
                          backgroundColor: c.color,
                          borderRadius: 4,
                        }}
                      />
                    </View>
                    {selectedCategory === c.name && (
                      <Text style={styles.muted}>
                        {((c.amount / total) * 100).toFixed(1)}% do total de{' '}
                        {money(total)}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </View>
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  Próximas contas
                </Text>
                {upcomingPayments(overview.upcoming).map((entry) => (
                  <View key={entry.key} style={{ gap: 8, paddingVertical: 6 }}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        if (entry.cardInvoice) onTransactions();
                        else onEdit(entry.items[0]);
                      }}
                    >
                      <Text style={styles.text}>
                        {entry.name} · {money(entry.total)}
                      </Text>
                      <Text
                        style={[styles.muted, entry.overdue && styles.danger]}
                      >
                        {dateLabel(entry.dueDate)} ·{' '}
                        {entry.overdue ? 'Em atraso · ' : ''}
                        {entry.detail}
                      </Text>
                    </Pressable>
                    <Button
                      label={
                        entry.cardInvoice
                          ? `Pagar ${entry.name}`
                          : `Concluir ${entry.name}`
                      }
                      disabled={busy}
                      compact
                      icon="check"
                      onPress={() =>
                        Alert.alert(
                          entry.cardInvoice
                            ? 'Pagar fatura?'
                            : 'Concluir lançamento?',
                          `${entry.name}: ${entry.items.length} lançamento(s). O valor realizado informado será preservado e a data será hoje.`,
                          [
                            { text: 'Cancelar', style: 'cancel' },
                            {
                              text: 'Confirmar',
                              onPress: () => void settle(entry.items),
                            },
                          ],
                        )
                      }
                    />
                  </View>
                ))}
                {!overview.upcoming.length && (
                  <Text style={styles.muted}>
                    Nenhuma conta pendente neste mês.
                  </Text>
                )}
                <Button
                  label="Ver todos os lançamentos"
                  disabled={busy}
                  onPress={onTransactions}
                />
              </View>
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  Movimentações recentes
                </Text>
                {overview.recent.map((t) => (
                  <Pressable
                    key={t.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Editar ${t.description}`}
                    disabled={busy}
                    onPress={() => onEdit(t)}
                    style={{ gap: 4, paddingVertical: 10 }}
                  >
                    <Text style={styles.text}>{t.description}</Text>
                    <Text
                      style={
                        t.kind === 'income' ? styles.positive : styles.danger
                      }
                    >
                      {money(t.actualAmount ?? t.plannedAmount)}
                    </Text>
                    <Text style={styles.muted}>
                      {t.categoryName ?? 'Sem categoria'} ·{' '}
                      {dateLabel(t.dueDate)}
                    </Text>
                  </Pressable>
                ))}
                {!overview.recent.length && (
                  <Text style={styles.muted}>Sem movimentações neste mês.</Text>
                )}
              </View>
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.heading}>
                  Seus objetivos
                </Text>
                {overview.goals.map((g) => (
                  <Pressable
                    key={g.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Abrir objetivo ${g.name}`}
                    disabled={busy}
                    onPress={onGoals}
                    style={{ gap: 4, paddingVertical: 10 }}
                  >
                    <Text style={styles.text}>
                      {g.name} · {Math.round(g.progress * 100)}%
                    </Text>
                    <Text style={styles.muted}>
                      {money(g.savedAmount)} de {money(g.targetAmount)}
                    </Text>
                  </Pressable>
                ))}
                <Button
                  label={
                    overview.goals.length ? 'Ver objetivos' : 'Criar objetivo'
                  }
                  disabled={busy}
                  onPress={onGoals}
                />
              </View>
              <Button
                label="Ver painel anual"
                icon="year"
                disabled={busy}
                onPress={onAnnual}
              />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
