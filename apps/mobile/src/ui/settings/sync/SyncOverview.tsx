import {
  syncPanelState,
  syncStatusDescription,
  syncStatusTitle,
} from '@lionpocket/sync-local';
import React from 'react';
import { Text, View } from 'react-native';
import { useAppearance } from '../../Appearance';
import { Button } from '../../components';
import { Icon } from '../../Icon';
import { useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

/** Current state of this device and the everyday sync actions. */
export function SyncOverview({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const { colors } = useAppearance();
  const { connected, canManage, needsAttention } = syncPanelState(status);
  const tone = needsAttention
    ? colors.gold
    : connected
      ? colors.positive
      : colors.primaryInk;
  return (
    <View
      style={[
        styles.card,
        connected && !needsAttention && { borderColor: colors.positiveWash },
      ]}
    >
      <View style={styles.cardHeader} accessibilityLiveRegion="polite">
        <View style={[styles.cardIcon, { backgroundColor: `${tone}24` }]}>
          <Icon
            name={status.phase === 'local' ? 'data' : 'sync'}
            size={18}
            color={tone}
          />
        </View>
        <View style={styles.grow}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            {syncStatusTitle(status)}
          </Text>
          <Text style={styles.muted}>{syncStatusDescription(status)}</Text>
        </View>
      </View>
      {connected && (
        <View>
          <View style={styles.row}>
            <Text style={[styles.muted, styles.grow]}>Servidor</Text>
            <Text style={styles.text}>
              {status.endpoint ? new URL(status.endpoint).host : 'Não informado'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.muted, styles.grow]}>Última sincronização</Text>
            <Text style={styles.text}>
              {status.lastCompletedAt
                ? new Date(status.lastCompletedAt).toLocaleString('pt-BR')
                : 'Ainda não concluída'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.muted, styles.grow]}>Cofre</Text>
            <Text style={[styles.strong, { color: tone }]}>
              {status.lastCompletedAt
                ? 'Sincronização pronta'
                : 'Sincronizando dados…'}
            </Text>
          </View>
        </View>
      )}
      {canManage && (
        <View style={styles.actions}>
          <Button
            label={busy ? 'Aguarde…' : 'Sincronizar agora'}
            icon="sync"
            tone="primary"
            disabled={busy || status.paused || status.restoreReview}
            onPress={() => act((c) => c.sync())}
          />
          <Button
            label={
              status.paused
                ? 'Retomar sincronização'
                : 'Pausar mantendo pendências'
            }
            disabled={busy}
            onPress={() => act((c) => c.pause(!status.paused))}
          />
        </View>
      )}
    </View>
  );
}
