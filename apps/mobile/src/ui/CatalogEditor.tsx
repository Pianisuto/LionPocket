import React, { useRef, useState } from 'react';
import { Alert, Keyboard, KeyboardAvoidingView, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  CatalogInput,
  Catalogs,
  Category,
  CreditCard,
  MoneyKind,
  SimpleCatalogItem,
} from '@lionpocket/core';
import { Button, Choice, Field, styles } from './components';
export function CatalogEditor({
  catalogs,
  onClose,
  onSave,
  onDelete,
}: {
  catalogs: Catalogs;
  onClose: () => void;
  onSave: (input: CatalogInput) => Promise<void>;
  onDelete: (type: CatalogInput['type'], id: string) => Promise<void>;
}) {
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [type, setType] = useState<CatalogInput['type']>('card');
  const [name, setName] = useState('');
  const [id, setId] = useState<string | undefined>();
  const [color, setColor] = useState('#8f8bff');
  const [kind, setKind] = useState<MoneyKind>('expense');
  const [dueDay, setDueDay] = useState('10');
  const [closingDay, setClosingDay] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    Keyboard.dismiss();
    setError('');
    setSuccess('');
    try {
      await onSave({
        id,
        color,
        type,
        name,
        kind,
        dueDay: Number(dueDay),
        closingDay: closingDay.trim() ? Number(closingDay) : null,
      });
      setName('');
      setId(undefined);
      setSuccess('Cadastro salvo. Disponível nos lançamentos.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar cadastro.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const items: Array<Category | CreditCard | SimpleCatalogItem> =
    type === 'card'
      ? catalogs.cards
      : type === 'category'
        ? catalogs.categories.filter((c) => c.kind === kind)
        : catalogs.paymentMethods;
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
          <ScrollView
            ref={scroll}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            <View style={styles.row}>
              <Text style={[styles.heading, { flex: 1 }]}>Cadastros</Text>
              <Button label="Fechar" onPress={onClose} disabled={busy} />
            </View>
            <Choice
              label="Cadastro"
              value={type}
              options={[
                { value: 'card', label: 'Cartões' },
                { value: 'category', label: 'Categorias' },
                { value: 'paymentMethod', label: 'Formas de pagamento' },
              ]}
              onChange={(value) => {
                setType(value as CatalogInput['type']);
                setId(undefined);
                setName('');
                setError('');
                setSuccess('');
              }}
            />
            {type === 'category' && (
              <Choice
                label="Tipo da categoria"
                value={kind}
                options={[
                  { value: 'expense', label: 'Saída' },
                  { value: 'income', label: 'Entrada' },
                ]}
                onChange={(v) => setKind(v as MoneyKind)}
              />
            )}
            {id && (
              <>
                <Text style={styles.positive}>Editando cadastro</Text>
                <Button
                  label="Novo cadastro"
                  disabled={busy}
                  onPress={() => {
                    setId(undefined);
                    setName('');
                  }}
                />
              </>
            )}
            {type === 'category' && (
              <Field label="Cor" value={color} onChange={setColor} hint="#RRGGBB" />
            )}
            <Field label="Nome" value={name} onChange={setName} />
            {type === 'card' && (
              <>
                <Field
                  label="Dia do vencimento"
                  value={dueDay}
                  numeric
                  onChange={setDueDay}
                  hint="1 a 31"
                />
                <Field
                  label="Dia do fechamento"
                  value={closingDay}
                  numeric
                  onChange={setClosingDay}
                  hint="Opcional; 1 a 31"
                />
              </>
            )}
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            {success ? <Text style={styles.positive}>{success}</Text> : null}
            <Button
              label={busy ? 'Salvando…' : id ? 'Salvar cadastro' : 'Adicionar cadastro'}
              tone="primary"
              disabled={busy}
              onPress={() => void save()}
            />
            <Text style={styles.heading}>Disponíveis</Text>
            {items.map((item) => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.heading}>{item.name}</Text>
                {'dueDay' in item && (
                  <Text style={styles.muted}>
                    Fecha {(item as CreditCard).closingDay ?? 'não informado'} · vence{' '}
                    {(item as CreditCard).dueDay}
                  </Text>
                )}
                {'color' in item && (
                  <Text style={{ color: (item as Category).color }}>
                    ● {(item as Category).color}
                  </Text>
                )}
                <View style={styles.row}>
                  <Button
                    label={`Editar ${item.name}`}
                    disabled={busy}
                    onPress={() => {
                      scroll.current?.scrollTo({ y: 0, animated: true });
                      setId(item.id);
                      setName(item.name);
                      setError('');
                      setSuccess('');
                      if ('dueDay' in item) {
                        setDueDay(String((item as CreditCard).dueDay));
                        setClosingDay(
                          (item as CreditCard).closingDay == null
                            ? ''
                            : String((item as CreditCard).closingDay),
                        );
                      }
                      if ('color' in item) setColor((item as Category).color);
                    }}
                  />
                  <Button
                    label={`Excluir ${item.name}`}
                    tone="danger"
                    disabled={busy}
                    onPress={() =>
                      Alert.alert(
                        'Excluir cadastro?',
                        `${item.name}. Os vínculos serão removidos de lançamentos e planejamentos. Valores e datas permanecem.`,
                        [
                          { text: 'Cancelar', style: 'cancel' },
                          {
                            text: 'Excluir',
                            style: 'destructive',
                            onPress: () => {
                              if (pending.current) return;
                              pending.current = true;
                              setBusy(true);
                              setError('');
                              void onDelete(type, item.id)
                                .then(() => {
                                  setId(undefined);
                                  setName('');
                                  setSuccess('Cadastro excluído.');
                                })
                                .catch((cause) =>
                                  setError(
                                    cause instanceof Error ? cause.message : 'Falha ao excluir.',
                                  ),
                                )
                                .finally(() => {
                                  pending.current = false;
                                  setBusy(false);
                                });
                            },
                          },
                        ],
                      )
                    }
                  />
                </View>
              </View>
            ))}
            {!items.length && <Text style={styles.muted}>Nenhum cadastro disponível.</Text>}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
