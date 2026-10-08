import React from 'react';
import { Text } from 'react-native';
import { Button } from '../../components';
import { SyncCard, useSyncStyles } from './kit';
import { type SyncSession } from './useSyncSession';

/** Next step after backup and unlink, according to the durable choice. */
export function ServerResetContinuation({
  status,
  busy,
  act,
  onConnectByInvite,
}: SyncSession & { onConnectByInvite: () => void }) {
  const styles = useSyncStyles();
  const reset = status.serverReset!;
  return (
    <SyncCard
      icon="data"
      title="Banco local preservado"
      description={`Backup criado: ${reset.backupPath}`}
    >
      {reset.intent === 'source-of-truth' ? (
        <>
          <Text style={styles.text}>
            Este aparelho foi escolhido como fonte de verdade. Crie o novo cofre
            usando seus dados locais.
          </Text>
          <Button
            label="Criar novo cofre usando estes dados"
            tone="primary"
            disabled={busy}
            onPress={() => act((c) => c.create())}
          />
        </>
      ) : (
        <>
          <Text style={styles.text}>
            Use o convite do aparelho que já recriou o cofre. Escaneie seu QR
            Code, abra o link LPV2 neste celular ou cole o convite abaixo. Este
            aparelho pedirá acesso e aguardará aprovação.
          </Text>
          <Button
            label="Conectar por convite"
            tone="primary"
            disabled={busy}
            onPress={onConnectByInvite}
          />
        </>
      )}
    </SyncCard>
  );
}
