import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { CatalogInput, Catalogs, CreditCard, MoneyKind } from '@lionpocket/core';
import { useAppearance } from '../../Appearance';
import { Button, useStyles } from '../../components';
import { SettingsGroup, SettingsRow, useSettingsStyles } from '../SettingsKit';
import { CatalogEditorSheet, type CatalogDraft } from './CatalogEditorSheet';

export type CatalogHandlers = {
  onSave: (input: CatalogInput) => Promise<void>;
  onDelete: (type: CatalogInput['type'], id: string) => Promise<void>;
  onCompleteDefaults: () => Promise<void>;
};

const blankDraft = (type: CatalogInput['type'], kind: MoneyKind = 'expense'): CatalogDraft => ({
  type,
  kind,
  name: '',
  color: '#F2557F',
  dueDay: '10',
  closingDay: '',
});

const cardSummary = (card: CreditCard) =>
  `${card.closingDay == null ? 'Fechamento não configurado' : `Fecha dia ${card.closingDay}`} · Vence dia ${card.dueDay}`;

function AddButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return <Button compact icon="plus" label={label} onPress={onPress} disabled={disabled} />;
}

/** Categories, payment methods and cards in readable lists; tap a row to edit. */
export function CatalogSettings({
  catalogs,
  onSave,
  onDelete,
  onCompleteDefaults,
  onBusyChange,
}: CatalogHandlers & {
  catalogs: Catalogs;
  onBusyChange: (busy: boolean) => void;
}) {
  const styles = useStyles();
  const settingsStyles = useSettingsStyles();
  const { colors } = useAppearance();
  const [editing, setEditing] = useState<CatalogDraft | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const open = (draft: CatalogDraft) => {
    if (pending.current) return;
    setNotice('');
    setError('');
    setEditing(draft);
  };
  const completeDefaults = () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    void onCompleteDefaults()
      .then(() =>
        setNotice('Categorias padrão adicionadas. Cadastros existentes preservados.'),
      )
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Falha ao adicionar categorias.'),
      )
      .finally(() => {
        pending.current = false;
        setBusy(false);
        onBusyChange(false);
      });
  };

  const categoryGroup = (kind: MoneyKind) => {
    const items = catalogs.categories.filter((item) => item.kind === kind);
    const singular = kind === 'income' ? 'entrada' : 'saída';
    return (
      <SettingsGroup
        title={kind === 'income' ? 'Categorias de entrada' : 'Categorias de saída'}
        count={items.length}
        action={
          <AddButton
            label="Adicionar"
            disabled={busy}
            onPress={() => open(blankDraft('category', kind))}
          />
        }
      >
        {items.map((item, index) => (
          <SettingsRow
            key={item.id}
            first={index === 0}
            leading={
              <View
                style={{
                  width: 14,
                  height: 14,
                  marginHorizontal: 12,
                  borderRadius: 7,
                  backgroundColor: item.color,
                }}
              />
            }
            title={item.name}
            disabled={busy}
            accessibilityLabel={`Editar categoria de ${singular} ${item.name}`}
            onPress={() =>
              open({ ...blankDraft('category', kind), id: item.id, name: item.name, color: item.color })
            }
          />
        ))}
        {!items.length && (
          <SettingsRow first title={`Nenhuma categoria de ${singular}.`} />
        )}
      </SettingsGroup>
    );
  };

  return (
    <>
      <Text style={settingsStyles.lead}>
        As listas usadas nos lançamentos, recorrências e parcelas. Toque em um
        item para editar ou excluir.
      </Text>
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={settingsStyles.notice}>
          {notice}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {categoryGroup('expense')}
      {categoryGroup('income')}
      <Button
        label="Adicionar categorias padrão faltantes"
        disabled={busy}
        onPress={completeDefaults}
      />
      <SettingsGroup
        title="Formas de pagamento"
        count={catalogs.paymentMethods.length}
        action={
          <AddButton label="Adicionar" disabled={busy} onPress={() => open(blankDraft('paymentMethod'))} />
        }
      >
        {catalogs.paymentMethods.map((item, index) => (
          <SettingsRow
            key={item.id}
            first={index === 0}
            icon="wallet"
            title={item.name}
            disabled={busy}
            accessibilityLabel={`Editar forma de pagamento ${item.name}`}
            onPress={() =>
              open({ ...blankDraft('paymentMethod'), id: item.id, name: item.name })
            }
          />
        ))}
        {!catalogs.paymentMethods.length && (
          <SettingsRow first title="Nenhuma forma de pagamento." />
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Cartões de crédito"
        count={catalogs.cards.length}
        action={<AddButton label="Adicionar" disabled={busy} onPress={() => open(blankDraft('card'))} />}
      >
        {catalogs.cards.map((card, index) => (
          <SettingsRow
            key={card.id}
            first={index === 0}
            icon="card"
            iconColor={card.closingDay == null ? colors.gold : undefined}
            title={card.name}
            disabled={busy}
            description={cardSummary(card)}
            accessibilityLabel={`Editar cartão ${card.name}`}
            onPress={() =>
              open({
                ...blankDraft('card'),
                id: card.id,
                name: card.name,
                dueDay: String(card.dueDay),
                closingDay: card.closingDay == null ? '' : String(card.closingDay),
              })
            }
          />
        ))}
        {!catalogs.cards.length && <SettingsRow first title="Nenhum cartão cadastrado." />}
      </SettingsGroup>
      {editing && (
        <CatalogEditorSheet
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await onSave(input);
            setNotice('Cadastro salvo. Disponível nos lançamentos.');
          }}
          onDelete={async (type, id) => {
            await onDelete(type, id);
            setNotice('Cadastro excluído.');
          }}
        />
      )}
    </>
  );
}
