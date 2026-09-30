import { useAppearance } from './Appearance';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Transaction } from '@lionpocket/core';
import { priorityMoveAnchor, todayIso } from '@lionpocket/core';
import { Button, IconButton, dateLabel, money, useStyles } from './components';
import { Icon } from './Icon';
import { fonts, type Palette } from './theme';
const statusLabels = {
  planned: 'Planejado',
  paid: 'Pago',
  received: 'Recebido',
  cancelled: 'Cancelado',
};
export function TransactionCard({
  item,
  busy,
  selected,
  priorities,
  month,
  onSelect,
  onSettle,
  onEdit,
  onDelete,
  onPin,
  onMove,
  showPriorities = true,
}: {
  item: Transaction;
  busy: boolean;
  selected: boolean;
  priorities: Transaction[];
  month: string;
  showPriorities?: boolean;
  onSelect: () => void;
  onSettle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onMove: (delta: number) => void;
}) {
  const styles = useStyles();
  const { colors } = useAppearance();
  const s = createS(colors);
  const [expanded, setExpanded] = useState(false);
  const income = item.kind === 'income';
  const pinned = showPriorities && item.priorityPosition !== null;
  const tone = income ? colors.positive : colors.negative;
  return (
    <View
      style={[
        s.card,
        pinned && { borderColor: colors.lineStrong },
        selected && { borderColor: colors.primary },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.description}, ${money(item.actualAmount ?? item.plannedAmount)}, ${item.isOverdue ? 'Em atraso' : statusLabels[item.status]}. ${expanded ? 'Ocultar' : 'Mostrar'} detalhes e ações`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={s.main}
      >
        <View
          style={[
            s.symbol,
            {
              backgroundColor: income
                ? colors.positiveWash
                : colors.negativeWash,
            },
          ]}
        >
          <Icon name={income ? 'up' : 'down'} size={20} color={tone} />
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={s.name} numberOfLines={expanded ? undefined : 1}>
            {item.description}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {item.categoryName ?? 'Sem categoria'} ·{' '}
            {dateLabel(item.dueDate).slice(0, 5)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 5, maxWidth: '45%' }}>
          <Text style={[s.amount, { color: tone }]}>
            {money(item.actualAmount ?? item.plannedAmount)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {pinned && <Icon name="pin" size={12} color={colors.primaryInk} />}
            <Text style={[s.status, item.isOverdue && { color: colors.alert }]}>
              {item.isOverdue ? 'Em atraso' : statusLabels[item.status]}
            </Text>
          </View>
        </View>
      </Pressable>
      {expanded && (
        <View style={s.details}>
          <Text style={styles.muted}>
            Previsto: {money(item.plannedAmount)} · Vencimento{' '}
            {dateLabel(item.dueDate)}
          </Text>
          {item.settledDate && (
            <Text style={styles.muted}>
              {income ? 'Recebido' : 'Pago'} em {dateLabel(item.settledDate)}
            </Text>
          )}
          {[item.paymentMethodName, item.cardName].filter(Boolean).length >
            0 && (
            <Text style={styles.muted}>
              {[item.paymentMethodName, item.cardName]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          )}
          {item.purchaseDate && (
            <Text style={styles.muted}>
              Compra: {dateLabel(item.purchaseDate)}
            </Text>
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
          {item.isOverdue && item.dueDate.slice(0, 7) < month && (
            <Text style={styles.muted}>
              Pendente de{' '}
              {item.dueDate.slice(0, 7).split('-').reverse().join('/')}
            </Text>
          )}
          {item.kind === 'expense' &&
            item.status === 'paid' &&
            (item.settledDate ?? item.dueDate).slice(0, 7) !== month && (
              <Text style={styles.muted}>
                Conta no saldo de{' '}
                {(item.settledDate ?? item.dueDate)
                  .slice(0, 7)
                  .split('-')
                  .reverse()
                  .join('/')}
                .
              </Text>
            )}
          {item.isOverdue &&
            item.dueDate.slice(0, 7) === month &&
            month < todayIso().slice(0, 7) && (
              <Text style={styles.muted}>
                Carregada adiante; fora da projeção deste mês.
              </Text>
            )}
          {!!item.notes && <Text style={styles.text}>{item.notes}</Text>}
          <View style={styles.row}>
            {item.status === 'planned' && (
              <Button
                label={income ? 'Receber' : 'Pagar'}
                icon="check"
                tone="primary"
                compact
                disabled={busy}
                onPress={onSettle}
              />
            )}
            <Button label="Editar" compact disabled={busy} onPress={onEdit} />
            {showPriorities && (
              <IconButton
                label={
                  pinned
                    ? `Retirar prioridade ${item.priorityPosition! + 1}`
                    : 'Priorizar'
                }
                icon="pin"
                active={pinned}
                disabled={busy}
                onPress={onPin}
              />
            )}
            {pinned && (
              <>
                <IconButton
                  label="Subir prioridade"
                  icon="arrowUp"
                  disabled={
                    busy ||
                    !priorityMoveAnchor(priorities, item, 'up').available
                  }
                  onPress={() => onMove(-1)}
                />
                <IconButton
                  label="Descer prioridade"
                  icon="arrowDown"
                  disabled={
                    busy ||
                    !priorityMoveAnchor(priorities, item, 'down').available
                  }
                  onPress={() => onMove(1)}
                />
              </>
            )}
          </View>
          <View style={styles.row}>
            {item.status === 'planned' && (
              <Button
                label={selected ? 'Selecionado ✓' : 'Selecionar'}
                compact
                disabled={busy}
                onPress={onSelect}
              />
            )}
            <Button
              label="Excluir"
              tone="danger"
              compact
              disabled={busy}
              onPress={onDelete}
            />
          </View>
        </View>
      )}
    </View>
  );
}
const createS = (colors: Palette) =>
  StyleSheet.create({
    card: {
      marginHorizontal: 20,
      marginBottom: 10,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    main: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      minHeight: 82,
    },
    symbol: {
      width: 36,
      height: 36,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    name: { fontFamily: fonts.bold, color: colors.text, fontSize: 14 },
    amount: {
      fontFamily: fonts.bold,
      fontSize: 15,
      fontVariant: ['tabular-nums'],
    },
    status: { fontFamily: fonts.ui, color: colors.muted, fontSize: 11 },
    details: {
      padding: 16,
      gap: 10,
      borderTopColor: colors.line,
      borderTopWidth: 1,
    },
  });
