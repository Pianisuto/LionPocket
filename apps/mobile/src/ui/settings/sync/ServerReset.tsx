import { serverResetCopy } from '@lionpocket/sync-local';
import type { ServerResetIntent } from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components';
import { SyncCard, SyncCheck, SyncChoice, SyncField, useSyncStyles } from './kit';
import { useEndpointDraft, type SyncSession } from './useSyncSession';

/**
 * Leaves a vault whose server was recreated. Both continuations stay visible,
 * and consent is cleared whenever the choice changes.
 */
export function ServerResetForm({ status, busy, act }: SyncSession) {
  const styles = useSyncStyles();
  const [intent, setIntent] = useState<ServerResetIntent>();
  const [confirmed, setConfirmed] = useState(false);
  const [endpoint, setEndpoint] = useEndpointDraft(status.endpoint);
  return (
    <SyncCard
      icon="server"
      tone="danger"
      title={serverResetCopy.title}
      description={serverResetCopy.description}
    >
      <View style={styles.actions}>
        <Text style={styles.label}>{serverResetCopy.question}</Text>
        {serverResetCopy.choices.map((choice) => (
          <SyncChoice
            key={choice.intent}
            label={choice.label}
            description={choice.description}
            checked={intent === choice.intent}
            disabled={busy}
            onPress={() => {
              setIntent(choice.intent);
              setConfirmed(false);
            }}
          />
        ))}
      </View>
      <SyncField
        label="Novo servidor"
        value={endpoint}
        onChangeText={setEndpoint}
        keyboardType="url"
      />
      <SyncCheck
        label={serverResetCopy.consent}
        checked={confirmed}
        disabled={busy || !intent}
        onChange={setConfirmed}
      />
      <Button
        label={serverResetCopy.action}
        tone="primary"
        disabled={busy || !intent || !confirmed || !endpoint.trim()}
        onPress={() =>
          act((c) => c.resetForRecreatedServer(endpoint, intent!, confirmed))
        }
      />
    </SyncCard>
  );
}

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
