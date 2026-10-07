import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '../../components';
import { SyncCard, SyncDisclosure, SyncField, useSyncStyles } from './kit';
import { useEndpointDraft, type SyncSession } from './useSyncSession';

/** First connection of this device to the user's own sync server. */
export function SyncSetup({
  status,
  busy,
  act,
  direct,
}: SyncSession & {
  /** Opened from an invitation link: skip the introduction. */
  direct: boolean;
}) {
  const styles = useSyncStyles();
  const [open, setOpen] = useState(false);
  const [endpoint, setEndpoint] = useEndpointDraft(status.endpoint);
  if (!open && !direct)
    return (
      <SyncCard
        icon="sync"
        title="Seus dados em mais de um aparelho"
        description="Conecte seu servidor próprio para manter celular e computador atualizados, com criptografia de ponta a ponta."
      >
        <Button
          label="Configurar sincronização"
          tone="primary"
          onPress={() => setOpen(true)}
        />
      </SyncCard>
    );
  return (
    <SyncCard
      icon="server"
      title="Conectar ao servidor"
      description="Informe o endereço do seu servidor de sincronização. Um novo cofre será criado com os dados deste aparelho."
    >
      <SyncField
        label="Servidor próprio"
        placeholder="https://sync.exemplo.com"
        value={endpoint}
        onChangeText={setEndpoint}
        keyboardType="url"
      />
      <View style={styles.actions}>
        <Button
          label="Conectar"
          tone="primary"
          disabled={busy || !endpoint.trim()}
          onPress={() =>
            act(async (c) => {
              await c.configure(endpoint);
              await c.create();
            })
          }
        />
        {!direct && (
          <Text style={styles.muted}>
            Já usa o LionPocket em outro aparelho? Use o convite abaixo.
          </Text>
        )}
      </View>
    </SyncCard>
  );
}

/** Restores a vault from the package and code kept outside the app. */
export function RecoverVault({ busy, act }: SyncSession) {
  const [open, setOpen] = useState(false);
  const [recoveryPackage, setRecoveryPackage] = useState('');
  const [code, setCode] = useState('');
  return (
    <SyncDisclosure
      icon="shield"
      title="Recuperar um cofre existente"
      description="Use o pacote e o código guardados fora do aplicativo."
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <SyncField
        label="Pacote de recuperação"
        value={recoveryPackage}
        onChangeText={setRecoveryPackage}
      />
      <SyncField
        label="Código de recuperação"
        secureTextEntry
        value={code}
        onChangeText={setCode}
      />
      <Button
        label="Recuperar cofre"
        tone="primary"
        disabled={busy || !recoveryPackage || !code}
        onPress={() => act((c) => c.recover(recoveryPackage, code))}
      />
    </SyncDisclosure>
  );
}

export function ResumeVaultCreation({ busy, act }: SyncSession) {
  return (
    <SyncCard
      icon="sync"
      title="Criação do cofre interrompida"
      description="Seus dados continuam neste aparelho. Retome para concluir a conexão."
    >
      <Button
        label="Retomar criação do cofre"
        tone="primary"
        disabled={busy}
        onPress={() => act((c) => c.create())}
      />
    </SyncCard>
  );
}
