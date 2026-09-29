import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { todayIso } from '@lionpocket/core/finance';
import type { MoneyKind, Transaction } from '@lionpocket/core/types';
import { createTransaction, listTransactions } from './src/db/transactions';
import { parseTransactionForm } from './src/transactionForm';

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

function AppContent(): React.JSX.Element {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [kind, setKind] = useState<MoneyKind>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(todayIso());
  const [settled, setSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTransactions()
      .then(setTransactions)
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Falha ao abrir o banco local.'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (busy) return;
    try {
      const input = parseTransactionForm(kind, description, amount, dueDate, settled);
      setBusy(true);
      setError(null);
      await createTransaction(input);
      setTransactions(await listTransactions());
      setDescription('');
      setAmount('');
      setDueDate(todayIso());
      setSettled(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o lançamento.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.eyebrow}>LIONPOCKET · NO SEU APARELHO</Text>
            <Text style={styles.title}>Lançamentos</Text>
            <Text style={styles.subtitle}>Suas entradas e saídas, disponíveis mesmo sem internet.</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Novo lançamento</Text>
            <View style={styles.segment}>
              {(['expense', 'income'] as const).map(value => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: kind === value }}
                  onPress={() => setKind(value)}
                  style={[styles.segmentButton, kind === value && styles.segmentSelected]}>
                  <Text style={[styles.segmentText, kind === value && styles.segmentTextSelected]}>
                    {value === 'expense' ? 'Saída' : 'Entrada'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.label}>Descrição</Text>
            <TextInput
              style={styles.input}
              value={description}
              onChangeText={setDescription}
              placeholder="Ex.: Mercado"
              placeholderTextColor="#8c879b"
              maxLength={120}
            />
            <Text style={styles.label}>Valor</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={setAmount}
              placeholder="0,00"
              placeholderTextColor="#8c879b"
              keyboardType="decimal-pad"
            />
            <Text style={styles.label}>Data prevista · AAAA-MM-DD</Text>
            <TextInput
              style={styles.input}
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="2026-09-29"
              placeholderTextColor="#8c879b"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
            />
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: settled }}
              onPress={() => setSettled(!settled)}
              style={styles.checkRow}>
              <View style={[styles.checkbox, settled && styles.checkboxChecked]}>
                {settled && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.checkLabel}>{kind === 'income' ? 'Já recebido' : 'Já pago'}</Text>
            </Pressable>
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || loading }}
              onPress={save}
              disabled={busy || loading}
              style={[styles.saveButton, (busy || loading) && styles.disabled]}>
              <Text style={styles.saveText}>{busy ? 'Salvando…' : 'Salvar lançamento'}</Text>
            </Pressable>
          </View>

          <View style={styles.listHeader}>
            <Text style={styles.sectionTitle}>Seus lançamentos</Text>
            <Text style={styles.count}>{transactions.length}</Text>
          </View>
          {loading ? <ActivityIndicator color="#7659d5" /> : transactions.length === 0 ? (
            <Text style={styles.empty}>Nenhum lançamento ainda. Cadastre o primeiro acima.</Text>
          ) : transactions.map(item => (
            <View key={item.id} style={styles.transaction}>
              <View style={styles.transactionBody}>
                <Text style={styles.transactionTitle}>{item.description}</Text>
                <Text style={styles.transactionMeta}>
                  {item.dueDate} · {item.status === 'planned' ? 'Planejado' : item.status === 'paid' ? 'Pago' : 'Recebido'}
                </Text>
              </View>
              <Text style={[styles.amount, item.kind === 'income' ? styles.income : styles.expense]}>
                {item.kind === 'income' ? '+' : '−'} {money(item.actualAmount ?? item.plannedAmount)}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#20183e' },
  content: { paddingBottom: 40, backgroundColor: '#f6f4fa' },
  header: { backgroundColor: '#20183e', paddingHorizontal: 24, paddingTop: 28, paddingBottom: 32 },
  eyebrow: { color: '#bdb0ee', fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: '#fff', fontSize: 32, fontWeight: '700', marginTop: 8 },
  subtitle: { color: '#d8d0ee', fontSize: 14, marginTop: 8, lineHeight: 20 },
  card: { backgroundColor: '#fff', borderRadius: 20, marginHorizontal: 16, marginTop: -12, padding: 20, elevation: 2 },
  sectionTitle: { color: '#241e38', fontSize: 19, fontWeight: '700' },
  segment: { flexDirection: 'row', backgroundColor: '#f1eef9', borderRadius: 10, padding: 4, marginTop: 20, marginBottom: 8 },
  segmentButton: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  segmentSelected: { backgroundColor: '#684ac5' },
  segmentText: { color: '#5d5476', fontWeight: '600' },
  segmentTextSelected: { color: '#fff' },
  label: { color: '#443b59', fontSize: 13, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#ddd8e9', borderRadius: 10, color: '#241e38', paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, backgroundColor: '#fff' },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  checkbox: { width: 22, height: 22, borderWidth: 2, borderColor: '#8a78bc', borderRadius: 5, marginRight: 10, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#684ac5', borderColor: '#684ac5' },
  checkmark: { color: '#fff', fontWeight: '700' },
  checkLabel: { color: '#443b59', fontSize: 15 },
  error: { color: '#ab214a', marginBottom: 12 },
  saveButton: { backgroundColor: '#684ac5', borderRadius: 11, alignItems: 'center', padding: 14 },
  disabled: { opacity: 0.5 },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  listHeader: { flexDirection: 'row', alignItems: 'center', marginTop: 30, marginHorizontal: 20, marginBottom: 10 },
  count: { color: '#6c5b98', marginLeft: 9, fontWeight: '700' },
  empty: { color: '#766d88', marginHorizontal: 20, paddingVertical: 22, textAlign: 'center' },
  transaction: { backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 4, padding: 16, borderRadius: 12 },
  transactionBody: { flex: 1, paddingRight: 8 },
  transactionTitle: { color: '#241e38', fontWeight: '700', fontSize: 15 },
  transactionMeta: { color: '#766d88', fontSize: 12, marginTop: 4 },
  amount: { fontSize: 14, fontWeight: '700' },
  income: { color: '#167858' },
  expense: { color: '#b13f62' },
});
