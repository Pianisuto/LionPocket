import { useAppearance } from './Appearance';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAnnual } from '../db/transactions';
import {
  Button,
  IconButton,
  ScreenHeader,
  money,
  useStyles,
} from './components';
import { fonts, type Palette } from './theme';
import { Icon } from './Icon';
export function AnnualScreen({
  month,
  onClose,
  onMonth,
}: {
  month: string;
  onClose: () => void;
  onMonth: (month: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  const annual = createAnnual(colors);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(month);
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const [rows, setRows] = useState<Awaited<ReturnType<typeof getAnnual>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    setError('');
    setRows([]);
    try {
      const result = await getAnnual(String(year));
      if (revision === request.current) setRows(result);
    } catch (cause) {
      if (revision === request.current)
        setError(
          cause instanceof Error ? cause.message : 'Falha ao carregar o ano.',
        );
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, [year]);
  useEffect(() => {
    void load();
    return () => {
      ++request.current;
    };
  }, [load]);
  const total = (key: 'receivedIncome' | 'paidExpenses' | 'realizedBalance') =>
    rows.reduce((sum, r) => sum + r.summary[key], 0);
  const max = Math.max(
    ...rows.flatMap((r) => [
      r.summary.plannedIncome,
      r.summary.plannedExpenses,
    ]),
    1,
  );
  const monthName = (value: string, short = false) =>
    new Intl.DateTimeFormat('pt-BR', { month: short ? 'short' : 'long' })
      .format(new Date(`${value}-15T12:00:00`))
      .replace('.', '');
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <ScreenHeader
          title="Painel anual"
          subtitle="Veja como seu ano está evoluindo"
          onClose={onClose}
        />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={annual.yearNav}>
            <IconButton
              label="Ano anterior"
              icon="left"
              disabled={loading || year <= 1000}
              onPress={() => setYear(year - 1)}
            />
            <Text style={[styles.title, { flex: 1, textAlign: 'center' }]}>
              {year}
            </Text>
            <IconButton
              label="Próximo ano"
              icon="right"
              disabled={loading || year >= 9999}
              onPress={() => setYear(year + 1)}
            />
          </View>
          {loading && (
            <ActivityIndicator
              accessibilityLabel="Carregando ano"
              color={colors.primary}
            />
          )}
          {!!error && (
            <View style={styles.field}>
              <Text style={styles.error}>{error}</Text>
              <Button label="Tentar novamente" onPress={() => void load()} />
            </View>
          )}
          {!loading && !error && (
            <>
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.surface2,
                    borderColor: colors.lineStrong,
                  },
                ]}
              >
                <Text style={styles.label}>Saldo realizado no ano</Text>
                <Text
                  style={[
                    annual.balance,
                    total('realizedBalance') < 0 && styles.danger,
                  ]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {money(total('realizedBalance'))}
                </Text>
                <View style={annual.yearNav}>
                  <View style={{ flex: 1, gap: 6 }}>
                    <Text style={styles.muted}>Entradas recebidas</Text>
                    <Text style={[styles.text, styles.positive]}>
                      {money(total('receivedIncome'))}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 6 }}>
                    <Text style={styles.muted}>Saídas pagas</Text>
                    <Text style={[styles.text, styles.danger]}>
                      {money(total('paidExpenses'))}
                    </Text>
                  </View>
                </View>
              </View>
              <View style={styles.card}>
                <Text style={styles.heading}>Ao longo do ano</Text>
                <View style={styles.row}>
                  <View
                    style={[annual.dot, { backgroundColor: colors.positive }]}
                  />
                  <Text style={styles.muted}>Entradas previstas</Text>
                  <View
                    style={[annual.dot, { backgroundColor: colors.negative }]}
                  />
                  <Text style={styles.muted}>Saídas previstas</Text>
                </View>
                <View style={annual.chart}>
                  {rows.map(({ summary: r }) => (
                    <Pressable
                      key={r.month}
                      accessibilityRole="button"
                      accessibilityLabel={`${monthName(r.month)}: entradas previstas ${money(r.plannedIncome)}, saídas previstas ${money(r.plannedExpenses)}. Mostrar detalhes`}
                      onPress={() => setExpandedMonth(r.month)}
                      style={annual.chartMonth}
                    >
                      <View style={annual.bars}>
                        <View
                          style={[
                            annual.bar,
                            {
                              height:
                                r.plannedIncome > 0
                                  ? Math.max(3, (r.plannedIncome / max) * 98)
                                  : 0,
                              backgroundColor: colors.positive,
                            },
                          ]}
                        />
                        <View
                          style={[
                            annual.bar,
                            {
                              height:
                                r.plannedExpenses > 0
                                  ? Math.max(3, (r.plannedExpenses / max) * 98)
                                  : 0,
                              backgroundColor: colors.negative,
                            },
                          ]}
                        />
                      </View>
                      <Text style={annual.chartLabel}>
                        {monthName(r.month, true)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.muted}>
                  Toque em um mês para ver seus detalhes abaixo.
                </Text>
              </View>
              <Text style={styles.heading}>Mês a mês</Text>
            </>
          )}
          {rows.map(({ summary: r, categories }) => (
            <View
              key={r.month}
              style={[
                styles.card,
                { padding: 0, overflow: 'hidden' },
                expandedMonth === r.month && { borderColor: colors.lineStrong },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${monthName(r.month)}. Saldo realizado ${money(r.realizedBalance)}`}
                accessibilityState={{ expanded: expandedMonth === r.month }}
                onPress={() =>
                  setExpandedMonth(expandedMonth === r.month ? null : r.month)
                }
                style={annual.monthRow}
              >
                <Text
                  style={[
                    styles.text,
                    {
                      textTransform: 'capitalize',
                      flex: 1,
                      fontFamily: fonts.bold,
                    },
                  ]}
                >
                  {monthName(r.month)}
                </Text>
                <Text
                  style={[
                    styles.text,
                    r.realizedBalance < 0 ? styles.danger : styles.positive,
                  ]}
                >
                  {money(r.realizedBalance)}
                </Text>
                <Icon
                  name={expandedMonth === r.month ? 'arrowUp' : 'right'}
                  size={16}
                />
              </Pressable>
              {expandedMonth === r.month && (
                <View style={annual.detail}>
                  <View style={styles.row}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      Entradas previstas
                    </Text>
                    <Text style={[styles.text, styles.positive]}>
                      {money(r.plannedIncome)}
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      Entradas recebidas
                    </Text>
                    <Text style={[styles.text, styles.positive]}>
                      {money(r.receivedIncome)}
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      Saídas previstas
                    </Text>
                    <Text style={[styles.text, styles.danger]}>
                      {money(r.plannedExpenses)}
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      Saídas pagas
                    </Text>
                    <Text style={[styles.text, styles.danger]}>
                      {money(r.paidExpenses)}
                    </Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={[styles.label, { flex: 1 }]}>
                      Saldo projetado
                    </Text>
                    <Text style={styles.text}>{money(r.projectedBalance)}</Text>
                  </View>
                  {r.overdueExpenses > 0 && (
                    <Text style={styles.error}>
                      Em atraso: {money(r.overdueExpenses)}
                    </Text>
                  )}
                  <Text style={styles.label}>
                    Saídas por categoria · realizado ou previsto
                  </Text>
                  {categories.length ? (
                    categories.map((c, index) => (
                      <View key={index} style={styles.field}>
                        <View style={styles.row}>
                          <View
                            style={[annual.dot, { backgroundColor: c.color }]}
                          />
                          <Text style={[styles.text, { flex: 1 }]}>
                            {c.name}
                          </Text>
                          <Text style={styles.text}>{money(c.amount)}</Text>
                        </View>
                        <View style={annual.track}>
                          <View
                            style={{
                              height: 4,
                              borderRadius: 2,
                              backgroundColor: c.color,
                              width: `${Math.max(
                                0,
                                Math.min(
                                  100,
                                  (c.amount /
                                    Math.max(
                                      1,
                                      categories.reduce(
                                        (sum, category) =>
                                          sum + category.amount,
                                        0,
                                      ),
                                    )) *
                                    100,
                                ),
                              )}%`,
                            }}
                          />
                        </View>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.muted}>Sem saídas neste mês.</Text>
                  )}
                  <Button
                    label={`Abrir ${r.month}`}
                    icon="right"
                    onPress={() => {
                      onMonth(r.month);
                      onClose();
                    }}
                  />
                </View>
              )}
            </View>
          ))}
          <Text style={styles.muted}>
            Receitas por vencimento e despesas por pagamento. Pendências
            vencidas são carregadas para os meses seguintes, como no resumo
            mensal.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
const createAnnual = (colors: Palette) =>
  StyleSheet.create({
    yearNav: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    balance: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 34,
      letterSpacing: -1,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    chart: { flexDirection: 'row', gap: 4, marginTop: 8 },
    chartMonth: {
      flex: 1,
      minHeight: 126,
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 8,
    },
    bars: {
      height: 100,
      width: '100%',
      flexDirection: 'row',
      gap: 3,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    bar: { width: '35%', borderTopLeftRadius: 3, borderTopRightRadius: 3 },
    chartLabel: { color: colors.muted, fontFamily: fonts.medium, fontSize: 10 },
    monthRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 16,
      minHeight: 60,
    },
    detail: {
      padding: 18,
      gap: 14,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    track: { backgroundColor: colors.surface3, height: 4, borderRadius: 2 },
  });
