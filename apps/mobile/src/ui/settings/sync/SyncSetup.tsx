import {
  vaultConnectionCopy,
  type ServerResetIntent,
} from '@lionpocket/sync-local';
import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Button } from '../../components';
import {
  SyncCard,
  SyncChoice,
  SyncDisclosure,
  SyncField,
  useSyncStyles,
} from './kit';
import { InvitationSection } from './Pairing';
import { useEndpointDraft, type SyncSession } from './useSyncSession';

/** First connection of this device to the user's own sync server. */
export function SyncSetup({
  status,
  busy,
  act,
  setError,
  invitation,
  onInvitationChange,
  preview,
  inputRef,
}: SyncSession & {
  invitation: string;
  onInvitationChange: (invitation: string) => void;
  preview?: { id: string; endpoint: string };
  inputRef: React.Ref<React.ComponentRef<typeof TextInput>>;
}) {
  const styles = useSyncStyles();
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<ServerResetIntent>();
  const [endpoint, setEndpoint] = useEndpointDraft(status.endpoint);
  if (!open)
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
    <>
      <SyncCard
        icon="server"
        title="Configurar sincronização"
        description="Crie um cofre no primeiro aparelho ou use o convite de um aparelho conectado."
      >
        <View accessibilityRole="radiogroup" style={styles.actions}>
          <Text style={styles.label}>{vaultConnectionCopy.question}</Text>
          {vaultConnectionCopy.choices.map((choice) => (
            <SyncChoice
              key={choice.intent}
              label={choice.label}
              description={choice.description}
              checked={intent === choice.intent}
              disabled={busy}
              onPress={() => setIntent(choice.intent)}
            />
          ))}
        </View>
        <Text style={styles.muted}>{vaultConnectionCopy.backup}</Text>
        {intent === 'source-of-truth' && (
          <>
            <SyncField
              label="Servidor próprio"
              placeholder="https://sync.exemplo.com"
              value={endpoint}
              onChangeText={setEndpoint}
              keyboardType="url"
              editable={!busy}
            />
            <View style={styles.actions}>
              <Button
                label={vaultConnectionCopy.createAction}
                tone="primary"
                disabled={busy || !endpoint.trim()}
                onPress={() =>
                  act(async (c) => {
                    await c.configure(endpoint);
                    await c.create();
                  })
                }
              />
            </View>
          </>
        )}
      </SyncCard>
      {intent === 'join-existing' && (
        <InvitationSection
          status={status}
          busy={busy}
          act={act}
          setError={setError}
          invitation={invitation}
          onInvitationChange={onInvitationChange}
          preview={preview}
          inputRef={inputRef}
          fromLink={false}
          title="Entrar em um cofre existente por convite"
        />
      )}
    </>
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
