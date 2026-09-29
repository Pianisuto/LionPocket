import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  addMonths,
  currentMonthIso,
  groupCreditCardInvoices,
  summarizeMonth,
  todayIso,
} from '@lionpocket/core';
import type { Catalogs, MoneyKind, Transaction, TransactionStatus } from '@lionpocket/core';
import {
  createCatalog,
  deleteCatalog,
  settleTransactions,
  deleteTransaction,
  getCatalogs,
  listTransactions,
  saveTransaction,
  settleTransaction,
} from './src/db/transactions';
import { Button, Choice, dateLabel, money, styles } from './src/ui/components';
import { CatalogEditor } from './src/ui/CatalogEditor';
import { PlanningScreen, type PlanningArea } from './src/ui/PlanningScreen';
import { TransactionEditor } from './src/ui/TransactionEditor';

const statusLabels = {
  planned: 'Planejado',
  paid: 'Pago',
  received: 'Recebido',
  cancelled: 'Cancelado',
};
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
    new Date(`${month}-15T12:00:00`),
  );

function AppContent(): React.JSX.Element {
  const [month, setMonth] = useState(currentMonthIso());
  const [items, setItems] = useState<Transaction[]>([]);
  const [catalogs, setCatalogs] = useState<Catalogs>({
    categories: [],
    paymentMethods: [],
    cards: [],
  });
  const [kind, setKind] = useState<MoneyKind | 'all'>('all');
  const [status, setStatus] = useState<TransactionStatus | 'all' | 'overdue'>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ item: Transaction | null } | null>(null);
  const [planning, setPlanning] = useState<PlanningArea | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  const mutation = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    setError('');
    setReady(false);
    try {
      const [transactions, nextCatalogs] = await Promise.all([
        listTransactions({ month }),
        getCatalogs(),
      ]);
      if (revision === request.current) {
        setItems(transactions);
        setSelected([]);
        setCatalogs(nextCatalogs);
        setReady(true);
      }
    } catch (cause) {
      if (revision === request.current)
        setError(cause instanceof Error ? cause.message : 'Falha ao abrir o banco local.');
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, [month]);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !mutation.current) void refresh();
    });
    return () => {
      ++request.current;
      subscription.remove();
    };
  }, [refresh]);
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
  const mutate = async (action: () => Promise<void | string>, message: string) => {
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
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.'),
    );
  };
  const summary = summarizeMonth(items, month);
  const filtered = items.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      (status === 'all' || (status === 'overdue' ? item.isOverdue : item.status === status)),
  );
  const selectedPending = filtered.filter((i) => i.status === 'planned' && selected.includes(i.id));
  const invoices = groupCreditCardInvoices(items.filter((i) => i.status === 'planned'));
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
  const listHeader = (
    <View style={styles.content}>
      <Text style={[styles.muted, { letterSpacing: 2 }]}>LIONPOCKET · LOCAL</Text>
      <Text style={styles.title}>Seu mês</Text>
      <View style={styles.row}>
        <Button
          label="Mês anterior"
          disabled={busy || month === '1000-01'}
          onPress={() => changeMonth(addMonths(`${month}-01`, -1).slice(0, 7))}
        />
        <Button
          label="Próximo mês"
          disabled={busy || month === '9999-12'}
          onPress={() => changeMonth(addMonths(`${month}-01`, 1).slice(0, 7))}
        />
      </View>
      <View style={styles.row}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { flex: 1, textTransform: 'capitalize' }]}
        >
          {monthLabel(month)}
        </Text>
        <Button label="Hoje" disabled={busy} onPress={() => changeMonth(currentMonthIso())} />
      </View>
      {loading && <ActivityIndicator accessibilityLabel="Carregando mês" color="#b9adff" />}
      {error ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button label="Tentar novamente" onPress={() => void refresh()} disabled={busy} />
        </>
      ) : null}
      {ready && (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={[styles.label, { flex: 1 }]}>Entradas</Text>
            <Text style={styles.muted}>Planejadas / Recebidas</Text>
          </View>
          <Text style={[styles.heading, styles.positive]}>
            {money(summary.plannedIncome)} / {money(summary.receivedIncome)}
          </Text>
          <View style={styles.row}>
            <Text style={[styles.label, { flex: 1 }]}>Saídas</Text>
            <Text style={styles.muted}>Planejadas / Pagas</Text>
          </View>
          <Text style={[styles.heading, styles.danger]}>
            {money(summary.plannedExpenses)} / {money(summary.paidExpenses)}
          </Text>
          <Text style={styles.label}>Saldo projetado</Text>
          <Text
            style={[styles.heading, summary.projectedBalance < 0 ? styles.danger : styles.positive]}
          >
            {money(summary.projectedBalance)}
          </Text>
          <Text style={styles.label}>Saldo realizado</Text>
          <Text
            style={[styles.title, summary.realizedBalance < 0 ? styles.danger : styles.positive]}
          >
            {money(summary.realizedBalance)}
          </Text>
          {summary.overdueExpenses > 0 && (
            <Text style={styles.danger}>Em atraso: {money(summary.overdueExpenses)}</Text>
          )}
          <Text style={styles.muted}>
            Totais do mês completo. Despesas atrasadas são carregadas adiante; despesas pagas contam
            no mês do pagamento.
          </Text>
        </View>
      )}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.positive}>
          {notice}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button
          label="Novo lançamento"
          tone="primary"
          disabled={!ready || busy}
          onPress={() => setEditor({ item: null })}
        />
        <Button label="Cadastros" disabled={!ready || busy} onPress={() => setCatalogOpen(true)} />
      </View>
      <View style={styles.row}>
        <Button
          label="Recorrências"
          disabled={!ready || busy}
          onPress={() => setPlanning('recurring')}
        />
        <Button
          label="Parcelamentos"
          disabled={!ready || busy}
          onPress={() => setPlanning('installments')}
        />
        <Button label="Objetivos" disabled={!ready || busy} onPress={() => setPlanning('goals')} />
      </View>
      {ready && invoices.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.heading}>Faturas pendentes</Text>
          {invoices.map((invoice) => (
            <View key={invoice.key} style={styles.field}>
              <Text style={styles.text}>
                {invoice.name} · {dateLabel(invoice.dueDate)} · {money(invoice.total)}
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
      <Text style={styles.heading}>Lançamentos do mês</Text>
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
      {ready && (
        <>
          <Text style={styles.muted}>
            {filtered.length} lançamento(s) nesta consulta · {selectedPending.length} selecionado(s)
          </Text>
          <View style={styles.row}>
            <Button
              label="Selecionar pendentes"
              disabled={busy}
              onPress={() =>
                setSelected(filtered.filter((i) => i.status === 'planned').map((i) => i.id))
              }
            />
            <Button
              label="Limpar seleção"
              disabled={busy || !selected.length}
              onPress={() => setSelected([])}
            />
            <Button
              label="Concluir selecionados"
              disabled={busy || !selectedPending.length}
              onPress={() => settleBatch(selectedPending, 'Concluir lançamentos?')}
            />
          </View>
        </>
      )}
    </View>
  );
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <FlatList
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
            <Text style={[styles.muted, { padding: 20 }]}>
              {kind === 'all' && status === 'all'
                ? 'Nenhum lançamento neste mês. Adicione uma entrada ou saída.'
                : 'Nenhum lançamento corresponde aos filtros.'}
            </Text>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View style={[styles.card, { marginHorizontal: 20, marginBottom: 12 }]}>
            <View style={styles.row}>
              <Text style={[styles.heading, { flex: 1 }]}>{item.description}</Text>
              <Text style={item.kind === 'income' ? styles.positive : styles.danger}>
                {item.kind === 'income' ? 'Entrada' : 'Saída'}
              </Text>
            </View>
            <Text
              style={[styles.heading, item.kind === 'income' ? styles.positive : styles.danger]}
            >
              {money(item.actualAmount ?? item.plannedAmount)}
            </Text>
            <Text style={styles.muted}>
              Previsto: {money(item.plannedAmount)} · {dateLabel(item.dueDate)}
            </Text>
            <Text style={item.isOverdue ? styles.danger : styles.text}>
              {item.isOverdue ? 'Em atraso' : statusLabels[item.status]}
              {item.settledDate ? ` · ${dateLabel(item.settledDate)}` : ''}
            </Text>
            {item.isOverdue && item.dueDate.slice(0, 7) < month && (
              <Text style={styles.muted}>Pendente de {monthLabel(item.dueDate.slice(0, 7))}</Text>
            )}
            {item.isOverdue && item.dueDate.slice(0, 7) === month && month < currentMonthIso() && (
              <Text style={styles.muted}>Carregada adiante; fora da projeção deste mês.</Text>
            )}
            {item.kind === 'expense' &&
              item.status === 'paid' &&
              (item.settledDate ?? item.dueDate).slice(0, 7) !== month && (
                <Text style={styles.muted}>
                  Conta no saldo de {monthLabel((item.settledDate ?? item.dueDate).slice(0, 7))}.
                </Text>
              )}
            <Text style={styles.muted}>
              {[item.categoryName ?? 'Sem categoria', item.paymentMethodName, item.cardName]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {item.purchaseDate && (
              <Text style={styles.muted}>Compra: {dateLabel(item.purchaseDate)}</Text>
            )}
            {item.sourceType !== 'manual' && (
              <Text style={styles.muted}>
                {item.sourceType === 'recurring'
                  ? 'Recorrência'
                  : item.sourceType === 'installment'
                    ? `Parcela ${item.installmentNumber} de ${item.installmentTotal}`
                    : 'Importado'}
              </Text>
            )}
            {item.notes ? <Text style={styles.muted}>{item.notes}</Text> : null}
            <View style={styles.row}>
              {item.status === 'planned' && (
                <Button
                  label={selected.includes(item.id) ? 'Selecionado ✓' : 'Selecionar'}
                  disabled={busy}
                  onPress={() =>
                    setSelected(
                      selected.includes(item.id)
                        ? selected.filter((id) => id !== item.id)
                        : [...selected, item.id],
                    )
                  }
                />
              )}
              {item.status === 'planned' && (
                <Button
                  label={item.kind === 'income' ? 'Receber' : 'Pagar'}
                  disabled={busy}
                  onPress={() =>
                    act(
                      () => settleTransaction(item.id),
                      item.kind === 'income' ? 'Entrada recebida.' : 'Saída paga.',
                    )
                  }
                />
              )}
              <Button label="Editar" disabled={busy} onPress={() => setEditor({ item })} />
              <Button
                label="Excluir"
                tone="danger"
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    'Excluir lançamento?',
                    `“${item.description}” será removido do histórico.`,
                    [
                      { text: 'Cancelar', style: 'cancel' },
                      {
                        text: 'Excluir lançamento',
                        style: 'destructive',
                        onPress: () =>
                          act(() => deleteTransaction(item.id), 'Lançamento excluído.'),
                      },
                    ],
                  )
                }
              />
            </View>
          </View>
        )}
      />
      {editor && (
        <TransactionEditor
          item={editor.item}
          defaultDate={month === currentMonthIso() ? todayIso() : `${month}-01`}
          catalogs={catalogs}
          onClose={() => setEditor(null)}
          onSave={(input) =>
            mutate(async () => {
              await saveTransaction(input);
              setEditor(null);
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
      {catalogOpen && (
        <CatalogEditor
          catalogs={catalogs}
          onClose={() => setCatalogOpen(false)}
          onSave={(input) => mutate(() => createCatalog(input), 'Cadastro salvo.')}
          onDelete={(type, id) => mutate(() => deleteCatalog(type, id), 'Cadastro excluído.')}
        />
      )}
    </SafeAreaView>
  );
}
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
