import { unlinkServerCopy } from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components';
import { SyncCard, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

export function UnlinkServer({ busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const [confirming, setConfirming] = useState(false);
  return (
    <SyncCard icon="server" title={unlinkServerCopy.title} description={unlinkServerCopy.description}>
      {confirming ? (
        <View accessibilityLabel="Confirmar desvinculação do servidor">
          <Text style={styles.text}>{unlinkServerCopy.confirmation}</Text>
          <View style={styles.actions}>
            <Button label="Cancelar" disabled={busy} onPress={() => setConfirming(false)} />
            <Button label={unlinkServerCopy.action} disabled={busy} onPress={() => act(c => c.unlinkServer(true))} />
          </View>
        </View>
      ) : (
        <Button label={unlinkServerCopy.title} disabled={busy} onPress={() => setConfirming(true)} />
      )}
    </SyncCard>
  );
}
