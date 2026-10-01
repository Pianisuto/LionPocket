import { startSyncForeground } from './src/sync/foreground';
import { AppearanceProvider, useAppearance } from './src/ui/Appearance';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Pressable,
  StatusBar,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  addMonths,
  currentMonthIso,
  groupCreditCardInvoices,
  summarizeMonth,
  monthlyOverview,
  todayIso,
  filterTransactions,
  orderedTransactions,
  priorityMoveAnchor,
} from '@lionpocket/core';
import type {
  Catalogs,
  Goal,
  MoneyKind,
  Transaction,
  TransactionStatus,
  TransactionFilters,
  TransactionSort,
} from '@lionpocket/core';
import {
  createCatalog,
  listGoals,
  completeStandardCategories,
  deleteCatalog,
  settleTransactions,
  deleteTransaction,
  getCatalogs,
  listTransactions,
  saveTransaction,
  settleTransaction,
  setTransactionPriority,
} from './src/db/transactions';
import {
  Button,
  Choice,
  Field,
  IconButton,
  Sheet,
  MonthPicker,
  dateLabel,
  money,
  useStyles,
} from './src/ui/components';
import { PreferencesScreen } from './src/ui/PreferencesScreen';
import { OverviewScreen } from './src/ui/OverviewScreen';
import { LeoScreen } from './src/ui/LeoScreen';
import { exportLocal, recoveryBackup } from './src/files/localData';
import { AnnualScreen } from './src/ui/AnnualScreen';
import { DataScreen } from './src/ui/DataScreen';
import { CatalogEditor } from './src/ui/CatalogEditor';
import { PlanningScreen, type PlanningArea } from './src/ui/PlanningScreen';
import { TransactionEditor } from './src/ui/TransactionEditor';

import { fonts, type Palette } from './src/ui/theme';
import { Icon } from './src/ui/Icon';
import lionImage from './src/ui/assets/lion.png';
import { TransactionCard } from './src/ui/TransactionCard';
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
    new Date(`${month}-15T12:00:00`),
  );

function AppContent(): React.JSX.Element {
  const styles = useStyles();
  const {
    colors,
    preferences,
    loaded,
    error: preferenceError,
    reload: reloadPreferences,
  } = useAppearance();
  const layout = createLayout(colors);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [leoOpen, setLeoOpen] = useState(false);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [month, setMonth] = useState(currentMonthIso());
  const [items, setItems] = useState<Transaction[]>([]);
  const [catalogs, setCatalogs] = useState<Catalogs>({
    categories: [],
    paymentMethods: [],
    cards: [],
  });
  const [kind, setKind] = useState<MoneyKind | 'all'>('all');
  const [status, setStatus] = useState<TransactionStatus | 'all' | 'overdue'>(
    'all',
  );
  const [payment, setPayment] =
    useState<NonNullable<TransactionFilters['payment']>>('all');
  const [source, setSource] =
    useState<NonNullable<TransactionFilters['source']>>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TransactionSort>('date');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menu, setMenu] = useState<'plan' | 'more' | null>(null);
  const [invoicesOpen, setInvoicesOpen] = useState(false);
  const [annualOpen, setAnnualOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ item: Transaction | null } | null>(
    null,
  );
  const [planning, setPlanning] = useState<PlanningArea | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const mutation = useRef(false);
  const dataScreenOpen = useRef(false);
  dataScreenOpen.current = dataOpen;
  const refresh = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    setError('');
    setReady(false);
    try {
      const [transactions, nextCatalogs, nextGoals] = await Promise.all([
        listTransactions({ month }),
        getCatalogs(),
        listGoals(),
      ]);
      if (revision === request.current) {
        setItems(transactions);
        setSelected([]);
        setCatalogs(nextCatalogs);
        setGoals(nextGoals);
        setReady(true);
      }
    } catch (cause) {
      if (revision === request.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Falha ao abrir o banco local.',
        );
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, [month]);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !mutation.current && !dataScreenOpen.current)
        void refresh();
    });
    return () => {
      ++request.current;
      subscription.remove();
    };
  }, [refresh]);
  const syncRefresh = useRef(refresh);
  syncRefresh.current = refresh;
  useEffect(() => startSyncForeground(() => {
    if (!mutation.current && !dataScreenOpen.current) void syncRefresh.current();
  }), []);
  const changeMonth = (next: string) => {
    if (!busy) {
      if (next === month) {
        void refresh();
        return;
      }
      ++request.current;
      setItems([]);
      setReady(false);
      setMonth(next);
      setNotice('');
    }
  };
  const mutate = async (
    action: () => Promise<void | string>,
    message: string,
  ) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setNotice(typeof result === 'string' ? result : message);
      await refresh();
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const act = (action: () => Promise<void | string>, message: string) => {
    void mutate(action, message).catch((cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível concluir a ação.',
      ),
    );
  };
  const summary = summarizeMonth(items, month);
  const overview = ready ? monthlyOverview(items, goals, month) : null;
  const filtered = orderedTransactions(
    filterTransactions(items, {
      kind,
      status: status === 'overdue' ? 'all' : status,
      overdue: status === 'overdue',
      payment,
      source,
      search,
    }),
    sort,
    direction,
    preferences.showPriorities,
  );
  const priorities = orderedTransactions(
    items.filter((i) => i.priorityPosition !== null),
  );
  const movePriority = (item: Transaction, delta: number) => {
    const move = priorityMoveAnchor(
      priorities,
      item,
      delta < 0 ? 'up' : 'down',
    );
    if (!move.available) return;
    const before = move.beforeTransactionId;
    act(
      () =>
        setTransactionPriority({
          month,
          transactionId: item.id,
          pinned: true,
          beforeTransactionId: before,
        }),
      'Prioridades ordenadas.',
    );
  };
  const selectedPending = filtered.filter(
    (i) => i.status === 'planned' && selected.includes(i.id),
  );
  const invoices = groupCreditCardInvoices(
    items.filter((i) => i.status === 'planned'),
  );
  const settleBatch = (batch: Transaction[], title: string) =>
    Alert.alert(
      title,
      `${batch.length} lançamento(s). O valor realizado informado será preservado; os demais usam o previsto. Data de hoje.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Concluir',
          onPress: () =>
            act(async () => {
              const count = await settleTransactions(batch.map((i) => i.id));
              return `${count} lançamento(s) concluído(s).`;
            }, 'Lote concluído.'),
        },
      ],
    );
  const activeFilters = [
    kind !== 'all',
    status !== 'all',
    payment !== 'all',
    source !== 'all',
    Boolean(search.trim()),
  ].filter(Boolean).length;
  const listRef = useRef<FlatList<Transaction>>(null);
  const listHeader = (
    <View style={styles.content}>
      <View style={layout.monthNav}>
        <IconButton
          label="Mês anterior"
          icon="left"
          disabled={busy || month === '1000-01'}
          onPress={() => changeMonth(addMonths(`${month}-01`, -1).slice(0, 7))}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Escolher mês: ${monthLabel(month)}`}
          disabled={busy}
          onPress={() => setMonthPickerOpen(true)}
          style={{ flex: 1, alignItems: 'center', gap: 3 }}
        >
          <Text style={[styles.heading, { textTransform: 'capitalize' }]}>
            {monthLabel(month)}
          </Text>
          <Text style={styles.muted}>Toque para escolher um mês</Text>
        </Pressable>
        <IconButton
          label="Próximo mês"
          icon="right"
          disabled={busy || month === '9999-12'}
          onPress={() => changeMonth(addMonths(`${month}-01`, 1).slice(0, 7))}
        />
      </View>
      {loading && (
        <ActivityIndicator
          accessibilityLabel="Carregando mês"
          color={colors.primary}
        />
      )}
      {!!error && (
        <View style={styles.field}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button
            label="Tentar novamente"
            onPress={() => void refresh()}
            disabled={busy}
          />
        </View>
      )}
      {ready && (
        <>
          <View style={layout.balanceCard}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Saldo realizado</Text>
              </View>
              <Icon name="home" color={colors.primaryInk} size={20} />
            </View>
            <Text
              style={[
                layout.balance,
                summary.realizedBalance < 0 && { color: colors.negative },
              ]}
              adjustsFontSizeToFit
              numberOfLines={1}
            >
              {money(summary.realizedBalance)}
            </Text>
            <View style={layout.projected}>
              <Text style={styles.muted}>Projetado</Text>
              <Text
                style={[
                  layout.projectedValue,
                  summary.projectedBalance < 0 && styles.danger,
                ]}
              >
                {money(summary.projectedBalance)}
              </Text>
            </View>
          </View>
          <View style={layout.metrics}>
            <View style={layout.metric}>
              <View style={styles.row}>
                <Icon name="up" color={colors.positive} size={16} />
                <Text style={styles.label}>Entradas</Text>
              </View>
              <Text
                style={[layout.metricValue, styles.positive]}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {money(summary.receivedIncome)}
              </Text>
              <Text style={styles.muted}>
                Previstas {money(summary.plannedIncome)}
              </Text>
            </View>
            <View style={layout.metric}>
              <View style={styles.row}>
                <Icon name="down" color={colors.negative} size={16} />
                <Text style={styles.label}>Saídas</Text>
              </View>
              <Text
                style={[layout.metricValue, styles.danger]}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {money(summary.paidExpenses)}
              </Text>
              <Text style={styles.muted}>
                Previstas {money(summary.plannedExpenses)}
              </Text>
            </View>
          </View>
          {summary.overdueExpenses > 0 && (
            <Text style={styles.error}>
              Em atraso · {money(summary.overdueExpenses)}
            </Text>
          )}
        </>
      )}
      {ready && (
        <Button
          label="Visão geral do mês"
          icon="home"
          compact
          onPress={() => setOverviewOpen(true)}
        />
      )}
      {!!notice && (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.muted, styles.positive]}
        >
          {notice}
        </Text>
      )}
      {ready && invoices.length > 0 && (
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Faturas pendentes"
            accessibilityState={{ expanded: invoicesOpen }}
            onPress={() => setInvoicesOpen(!invoicesOpen)}
            style={styles.row}
          >
            <Icon name="card" color={colors.primaryInk} />
            <Text style={[styles.label, { flex: 1 }]}>
              {invoices.length} fatura(s) pendente(s)
            </Text>
            <Icon name={invoicesOpen ? 'arrowUp' : 'right'} size={16} />
          </Pressable>
          {invoicesOpen &&
            invoices.map((invoice) => (
              <View key={invoice.key} style={styles.field}>
                <Text style={styles.text}>
                  {invoice.name} · {dateLabel(invoice.dueDate)} ·{' '}
                  {money(invoice.total)}
                </Text>
                <Button
                  label={`Pagar ${invoice.name}`}
                  disabled={busy}
                  onPress={() => settleBatch(invoice.items, 'Pagar fatura?')}
                />
              </View>
            ))}
        </View>
      )}
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            Lançamentos
          </Text>
          <Text style={styles.muted}>
            {filtered.length} no mês
            {activeFilters ? ` · ${activeFilters} filtro(s)` : ''}
          </Text>
        </View>
        <IconButton
          label="Filtros e ordenação"
          icon="filter"
          active={activeFilters > 0}
          disabled={busy}
          onPress={() => setFiltersOpen(true)}
        />
      </View>
      <View style={layout.segments}>
        {(
          [
            { value: 'all', label: 'Todos' },
            { value: 'expense', label: 'Saídas' },
            { value: 'income', label: 'Entradas' },
          ] as const
        ).map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: kind === option.value }}
            onPress={() => setKind(option.value)}
            style={[
              layout.segment,
              kind === option.value && layout.segmentActive,
            ]}
          >
            <Text
              style={[
                layout.segmentText,
                kind === option.value && { color: colors.primaryInk },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {selected.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>
            {selectedPending.length} pendente(s) selecionado(s)
          </Text>
          <Button
            label="Concluir selecionados"
            tone="primary"
            disabled={busy || !selectedPending.length}
            onPress={() =>
              settleBatch(selectedPending, 'Concluir lançamentos?')
            }
          />
          <Button
            label="Limpar seleção"
            disabled={busy}
            onPress={() => setSelected([])}
          />
        </View>
      )}
    </View>
  );
  if (!loaded)
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  if (preferenceError)
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.error}>{preferenceError}</Text>
          <Button
            label="Tentar novamente"
            onPress={() =>
              void reloadPreferences()
                .then(refresh)
                .catch(() => undefined)
            }
          />
        </ScrollView>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar
        barStyle={
          preferences.theme === 'light' ? 'dark-content' : 'light-content'
        }
      />
      <View style={layout.brandHeader}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Falar com o Léo"
          disabled={!ready || busy}
          onPress={() => setLeoOpen(true)}
        >
          <Image source={lionImage} style={layout.logo} />
        </Pressable>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={layout.brand} numberOfLines={1} adjustsFontSizeToFit>
            Lion<Text style={{ color: colors.primaryInk }}>Pocket</Text>
          </Text>
          <View style={styles.row}>
            <View style={layout.localDot} />
            <Text style={styles.muted}>No seu aparelho</Text>
          </View>
        </View>
        <Button
          label="Novo"
          icon="plus"
          compact
          tone="primary"
          disabled={!ready || busy}
          onPress={() => setEditor({ item: null })}
        />
      </View>
      <FlatList
        ref={listRef}
        data={ready ? filtered : []}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshing={loading}
        onRefresh={() => {
          if (!busy) void refresh();
        }}
        ListEmptyComponent={
          ready ? (
            <View
              style={[
                styles.card,
                {
                  marginHorizontal: 20,
                  alignItems: 'center',
                  paddingVertical: 30,
                },
              ]}
            >
              <Icon name="home" color={colors.primaryInk} size={28} />
              <Text style={styles.heading}>
                {activeFilters ? 'Nenhum resultado' : 'Seu mês começa aqui'}
              </Text>
              <Text style={[styles.muted, { textAlign: 'center' }]}>
                {activeFilters
                  ? 'Ajuste os filtros para encontrar seus lançamentos.'
                  : 'Adicione uma entrada ou saída para acompanhar suas finanças.'}
              </Text>
              <Button
                label={activeFilters ? 'Revisar filtros' : 'Novo lançamento'}
                tone="primary"
                onPress={() =>
                  activeFilters
                    ? setFiltersOpen(true)
                    : setEditor({ item: null })
                }
              />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <TransactionCard
            item={item}
            busy={busy}
            selected={selected.includes(item.id)}
            priorities={priorities}
            showPriorities={preferences.showPriorities}
            month={month}
            onSelect={() =>
              setSelected(
                selected.includes(item.id)
                  ? selected.filter((id) => id !== item.id)
                  : [...selected, item.id],
              )
            }
            onSettle={() =>
              act(
                () => settleTransaction(item.id),
                item.kind === 'income' ? 'Entrada recebida.' : 'Saída paga.',
              )
            }
            onEdit={() => setEditor({ item })}
            onPin={() =>
              act(
                () =>
                  setTransactionPriority({
                    month,
                    transactionId: item.id,
                    pinned: item.priorityPosition === null,
                  }),
                'Prioridades atualizadas.',
              )
            }
            onMove={(delta) => movePriority(item, delta)}
            onDelete={() =>
              Alert.alert(
                'Excluir lançamento?',
                `“${item.description}” será removido do histórico.`,
                [
                  { text: 'Cancelar', style: 'cancel' },
                  {
                    text: 'Excluir lançamento',
                    style: 'destructive',
                    onPress: () =>
                      act(
                        () => deleteTransaction(item.id),
                        'Lançamento excluído.',
                      ),
                  },
                ],
              )
            }
          />
        )}
      />
      <View style={layout.bottomNav}>
        {(
          [
            {
              icon: 'home',
              label: 'Mês',
              onPress: () =>
                listRef.current?.scrollToOffset({ offset: 0, animated: true }),
            },
            { icon: 'plan', label: 'Planejar', onPress: () => setMenu('plan') },
            { icon: 'year', label: 'Ano', onPress: () => setAnnualOpen(true) },
            { icon: 'more', label: 'Mais', onPress: () => setMenu('more') },
          ] as const
        ).map((tab, index) => (
          <Pressable
            key={tab.label}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            accessibilityState={{
              selected: index === 0,
              disabled: !ready || busy,
            }}
            disabled={!ready || busy}
            onPress={tab.onPress}
            style={layout.navItem}
          >
            <View
              style={[
                layout.navIcon,
                index === 0 && { backgroundColor: colors.primaryWash },
              ]}
            >
              <Icon
                name={tab.icon}
                color={index === 0 ? colors.primaryInk : colors.muted}
                size={22}
              />
            </View>
            <Text
              style={[
                layout.navLabel,
                index === 0 && { color: colors.primaryInk },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {menu && (
        <Sheet
          title={menu === 'plan' ? 'Planejamento' : 'Seu LionPocket'}
          onClose={() => setMenu(null)}
        >
          {menu === 'plan' ? (
            <>
              <Text style={styles.muted}>
                Prepare os próximos meses e acompanhe seus objetivos.
              </Text>
              <Button
                label="Recorrências"
                icon="repeat"
                onPress={() => {
                  setMenu(null);
                  setPlanning('recurring');
                }}
              />
              <Button
                label="Parcelamentos"
                icon="card"
                onPress={() => {
                  setMenu(null);
                  setPlanning('installments');
                }}
              />
              <Button
                label="Objetivos"
                icon="goal"
                onPress={() => {
                  setMenu(null);
                  setPlanning('goals');
                }}
              />
            </>
          ) : (
            <>
              <Button
                label="Visão geral"
                icon="home"
                onPress={() => {
                  setMenu(null);
                  setOverviewOpen(true);
                }}
              />
              <Button
                label="Preferências"
                icon="settings"
                onPress={() => {
                  setMenu(null);
                  setPreferencesOpen(true);
                }}
              />
              <Button
                label="Falar com o Léo"
                onPress={() => {
                  setMenu(null);
                  setLeoOpen(true);
                }}
              />
              <Button
                label="Cadastros"
                icon="catalog"
                onPress={() => {
                  setMenu(null);
                  setCatalogOpen(true);
                }}
              />
              <Button
                label="Dados locais"
                icon="data"
                onPress={() => {
                  setMenu(null);
                  setDataOpen(true);
                }}
              />
              <Text style={styles.muted}>
                Seus dados ficam neste aparelho. Exporte uma cópia para guardar
                suas finanças com você.
              </Text>
            </>
          )}
        </Sheet>
      )}
      {filtersOpen && (
        <Sheet
          footer={
            <Button
              label={`Ver ${filtered.length} lançamento(s)`}
              tone="primary"
              onPress={() => setFiltersOpen(false)}
            />
          }
          title="Filtros e ordenação"
          onClose={() => setFiltersOpen(false)}
        >
          <Choice
            label="Filtrar por tipo"
            value={kind}
            options={[
              { value: 'all', label: 'Entradas e saídas' },
              { value: 'expense', label: 'Só saídas' },
              { value: 'income', label: 'Só entradas' },
            ]}
            onChange={(v) => setKind(v as MoneyKind | 'all')}
          />
          <Choice
            label="Filtrar por situação"
            value={status}
            options={[
              { value: 'all', label: 'Todas as situações' },
              { value: 'planned', label: 'Planejado' },
              { value: 'overdue', label: 'Em atraso' },
              { value: 'paid', label: 'Pago' },
              { value: 'received', label: 'Recebido' },
              { value: 'cancelled', label: 'Cancelado' },
            ]}
            onChange={(v) => setStatus(v as typeof status)}
          />

          <Field
            label="Buscar lançamentos"
            value={search}
            onChange={setSearch}
            hint="Descrição, categoria, pagamento, cartão, observações ou valor"
          />
          <Choice
            label="Filtrar por pagamento"
            value={payment}
            options={[
              { value: 'all', label: 'Todos os pagamentos' },
              { value: 'creditCard', label: 'Cartão de crédito' },
              { value: 'other', label: 'Outras formas' },
            ]}
            onChange={(v) => setPayment(v as typeof payment)}
          />
          <Choice
            label="Filtrar por origem"
            value={source}
            options={[
              { value: 'all', label: 'Todas as origens' },
              { value: 'manual', label: 'Manual' },
              { value: 'recurring', label: 'Recorrência' },
              { value: 'installment', label: 'Parcelamento' },
              { value: 'imported', label: 'Importado' },
            ]}
            onChange={(v) => setSource(v as typeof source)}
          />
          <Button
            label="Limpar filtros"
            onPress={() => {
              setKind('all');
              setStatus('all');
              setPayment('all');
              setSource('all');
              setSearch('');
              setSelected([]);
            }}
          />
          <Choice
            label="Ordenar lançamentos"
            value={sort}
            options={[
              { value: 'date', label: 'Vencimento' },
              { value: 'description', label: 'Descrição' },
              { value: 'amount', label: 'Valor' },
              { value: 'category', label: 'Categoria' },
              { value: 'paymentMethod', label: 'Pagamento' },
              { value: 'card', label: 'Cartão' },
              { value: 'purchaseDate', label: 'Compra' },
              { value: 'status', label: 'Situação' },
            ]}
            onChange={(v) => setSort(v as TransactionSort)}
          />
          <Button
            label={
              direction === 'asc' ? 'Ordem crescente' : 'Ordem decrescente'
            }
            onPress={() => setDirection(direction === 'asc' ? 'desc' : 'asc')}
          />
          <Text style={styles.muted}>
            {preferences.showPriorities
              ? 'Prioridades ficam no topo.'
              : 'Prioridades ocultas. Ative em Preferências para fixar e ordenar.'}{' '}
            Fixar uma recorrência prioriza todas as suas ocorrências a partir
            deste mês; retirar desfaz a prioridade da série.
          </Text>

          <Button
            label="Selecionar pendentes"
            disabled={busy}
            onPress={() => {
              setSelected(
                filtered.filter((i) => i.status === 'planned').map((i) => i.id),
              );
              setFiltersOpen(false);
            }}
          />
        </Sheet>
      )}
      {monthPickerOpen && (
        <MonthPicker
          month={month}
          onChange={changeMonth}
          onClose={() => setMonthPickerOpen(false)}
        />
      )}
      {preferencesOpen && (
        <PreferencesScreen onClose={() => setPreferencesOpen(false)} onChanged={async () => { await refresh(); }} />
      )}
      {overviewOpen && (
        <OverviewScreen
          month={month}
          onClose={() => setOverviewOpen(false)}
          onEdit={(item) => {
            setOverviewOpen(false);
            setEditor({ item });
          }}
          onSettle={(pendingItems) =>
            mutate(async () => {
              await settleTransactions(pendingItems.map((t) => t.id));
            }, 'Lançamentos concluídos.')
          }
          onGoals={() => {
            setOverviewOpen(false);
            setPlanning('goals');
          }}
          onAnnual={() => {
            setOverviewOpen(false);
            setAnnualOpen(true);
          }}
          onTransactions={() => {
            setOverviewOpen(false);
            listRef.current?.scrollToOffset({ offset: 0, animated: true });
          }}
        />
      )}
      {leoOpen && (
        <LeoScreen
          overview={overview}
          onClose={() => setLeoOpen(false)}
          onGoals={() => {
            setLeoOpen(false);
            setPlanning('goals');
          }}
          onBackup={() =>
            mutate(async () => {
              await recoveryBackup();
            }, 'Cópia local criada.')
          }
          onExport={async () => {
            let exported = false;
            await mutate(async () => {
              exported = await exportLocal('csv', month);
              return exported ? 'Arquivo CSV criado.' : 'Exportação cancelada.';
            }, 'Exportação concluída.');
            return exported;
          }}
        />
      )}
      {editor && (
        <TransactionEditor
          item={editor.item}
          defaultDate={month === currentMonthIso() ? todayIso() : `${month}-01`}
          catalogs={catalogs}
          onClose={() => setEditor(null)}
          onSave={(input, keepOpen) =>
            mutate(async () => {
              await saveTransaction(input);
              if (!keepOpen) setEditor(null);
            }, 'Lançamento salvo.')
          }
        />
      )}
      {planning && (
        <PlanningScreen
          area={planning}
          catalogs={catalogs}
          month={month}
          onMonth={changeMonth}
          onClose={() => setPlanning(null)}
          onChanged={refresh}
        />
      )}
      {annualOpen && (
        <AnnualScreen
          month={month}
          onClose={() => setAnnualOpen(false)}
          onMonth={changeMonth}
        />
      )}
      {dataOpen && (
        <DataScreen
          month={month}
          onClose={() => setDataOpen(false)}
          onChanged={async () => {
            await reloadPreferences();
            await refresh();
          }}
        />
      )}
      {catalogOpen && (
        <CatalogEditor
          catalogs={catalogs}
          onClose={() => setCatalogOpen(false)}
          onSave={(input) =>
            mutate(() => createCatalog(input), 'Cadastro salvo.')
          }
          onCompleteDefaults={() =>
            mutate(
              () => completeStandardCategories(),
              'Categorias padrão adicionadas. Cadastros existentes preservados.',
            )
          }
          onDelete={(type, id) =>
            mutate(() => deleteCatalog(type, id), 'Cadastro excluído.')
          }
        />
      )}
    </SafeAreaView>
  );
}
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <AppContent />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

const createLayout = (colors: Palette) =>
  StyleSheet.create({
    brandHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    logo: { width: 42, height: 42, borderRadius: 13 },
    brand: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 23,
      letterSpacing: -0.5,
    },
    localDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.positive,
    },
    monthNav: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    balanceCard: {
      backgroundColor: colors.surface2,
      borderColor: colors.lineStrong,
      borderWidth: 1,
      borderRadius: 22,
      padding: 20,
      gap: 12,
      overflow: 'hidden',
    },
    balance: {
      fontFamily: fonts.display,
      fontSize: 36,
      letterSpacing: -1,
      color: colors.text,
      fontVariant: ['tabular-nums'],
    },
    projected: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.lineStrong,
      flexWrap: 'wrap',
    },
    projectedValue: {
      color: colors.primaryInk,
      fontFamily: fonts.bold,
      fontSize: 14,
    },
    metrics: { flexDirection: 'row', gap: 10 },
    metric: {
      flex: 1,
      minWidth: 0,
      padding: 14,
      gap: 8,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    metricValue: {
      fontFamily: fonts.bold,
      fontSize: 19,
      fontVariant: ['tabular-nums'],
    },
    segments: {
      backgroundColor: colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 14,
      padding: 4,
      flexDirection: 'row',
    },
    segment: {
      flex: 1,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
    },
    segmentActive: { backgroundColor: colors.primaryWash },
    segmentText: { fontFamily: fonts.bold, color: colors.muted, fontSize: 13 },
    bottomNav: {
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: colors.line,
      backgroundColor: colors.deep,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 4,
    },
    navItem: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      minHeight: 60,
    },
    navIcon: {
      width: 50,
      height: 30,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 12,
    },
    navLabel: { color: colors.muted, fontFamily: fonts.medium, fontSize: 11 },
  });
