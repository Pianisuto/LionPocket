import React, { useRef, useState } from 'react';
import { Alert, Keyboard, Pressable, Text, View } from 'react-native';
import type { CatalogInput, MoneyKind } from '@lionpocket/core';
import { useAppearance } from '../../Appearance';
import { Button, Choice, Field, Sheet, useStyles } from '../../components';
import { Icon } from '../../Icon';

export type CatalogDraft = {
  id?: string;
  type: CatalogInput['type'];
  name: string;
  kind: MoneyKind;
  color: string;
  dueDay: string;
  closingDay: string;
};

/** Colours of the standard categories, offered as quick choices. */
const presetColors = [
  '#F2557F', '#FF9142', '#FFC247', '#4CC9F0', '#8B5CF6', '#2DD4BF',
  '#D946EF', '#7C9CF5', '#34D399', '#60A5FA', '#EF4444', '#9C8AA5',
];

const nouns: Record<CatalogInput['type'], { item: string; feminine: boolean }> = {
  category: { item: 'categoria', feminine: true },
  paymentMethod: { item: 'forma de pagamento', feminine: true },
  card: { item: 'cartão', feminine: false },
};

export const catalogSheetTitle = (draft: CatalogDraft) => {
  const { item, feminine } = nouns[draft.type];
  if (draft.id) return `Editar ${item}`;
  const kind =
    draft.type === 'category'
      ? draft.kind === 'income'
        ? ' de entrada'
        : ' de saída'
      : '';
  return `${feminine ? 'Nova' : 'Novo'} ${item}${kind}`;
};

/** Adds or edits one catalog item; deleting asks for confirmation. */
export function CatalogEditorSheet({
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  initial: CatalogDraft;
  onClose: () => void;
  onSave: (input: CatalogInput) => Promise<void>;
  onDelete: (type: CatalogInput['type'], id: string) => Promise<void>;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const change = (patch: Partial<CatalogDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError('');
  };
  const guard = async (action: () => Promise<void>, fallback: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    Keyboard.dismiss();
    try {
      await action();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    void guard(
      () =>
        onSave({
          id: draft.id,
          type: draft.type,
          name: draft.name,
          kind: draft.kind,
          color: draft.color,
          dueDay: Number(draft.dueDay),
          closingDay: draft.closingDay.trim() ? Number(draft.closingDay) : null,
        }),
      'Falha ao salvar cadastro.',
    );
  const remove = () =>
    Alert.alert(
      `Excluir ${nouns[draft.type].item}?`,
      `${initial.name}. Os vínculos serão removidos de lançamentos e planejamentos. Valores e datas permanecem.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: () =>
            void guard(() => onDelete(draft.type, draft.id!), 'Falha ao excluir.'),
        },
      ],
    );
  return (
    <Sheet
      title={catalogSheetTitle(initial)}
      onClose={onClose}
      disabled={busy}
      footer={
        <View style={{ gap: 10 }}>
          <Button
            label={busy ? 'Salvando…' : draft.id ? 'Salvar alterações' : 'Adicionar'}
            tone="primary"
            disabled={busy}
            onPress={save}
          />
          {draft.id && (
            <Button
              label={`Excluir ${nouns[draft.type].item}`}
              icon="trash"
              tone="danger"
              disabled={busy}
              onPress={remove}
            />
          )}
        </View>
      }
    >
      <Field label="Nome" value={draft.name} onChange={(name) => change({ name })} />
      {draft.type === 'category' && (
        <>
          <Choice
            label="Tipo"
            inline
            value={draft.kind}
            options={[
              { value: 'expense', label: 'Saída' },
              { value: 'income', label: 'Entrada' },
            ]}
            onChange={(kind) => change({ kind: kind as MoneyKind })}
          />
          <View style={styles.field}>
            <Text style={styles.label}>Cor</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {presetColors.map((color) => {
                const selected = draft.color.toLowerCase() === color.toLowerCase();
                return (
                  <Pressable
                    key={color}
                    accessibilityRole="radio"
                    accessibilityLabel={`Cor ${color}`}
                    accessibilityState={{ checked: selected }}
                    onPress={() => change({ color })}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: color,
                      borderWidth: 3,
                      borderColor: selected ? colors.text : 'transparent',
                    }}
                  >
                    {selected && <Icon name="check" size={16} color="#ffffff" />}
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Field
            label="Cor personalizada"
            value={draft.color}
            onChange={(color) => change({ color })}
            hint="#RRGGBB"
          />
        </>
      )}
      {draft.type === 'card' && (
        <>
          <Field
            label="Dia do fechamento"
            value={draft.closingDay}
            numeric
            onChange={(closingDay) => change({ closingDay })}
            hint="Opcional; 1 a 31. Define em qual fatura a compra entra."
          />
          <Field
            label="Dia do vencimento"
            value={draft.dueDay}
            numeric
            onChange={(dueDay) => change({ dueDay })}
            hint="1 a 31"
          />
        </>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </Sheet>
  );
}
