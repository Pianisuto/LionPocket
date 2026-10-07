import { canReplaceInvitation, pairingStepTitle } from '@lionpocket/sync-local';
import React from 'react';
import { NativeModules, Text, TextInput, View } from 'react-native';
import { Button } from '../../components';
import { SyncCard, SyncField, SyncNotice, useSyncStyles } from './kit';
import type { SyncSession } from './useSyncSession';

type InvitationProps = SyncSession & {
  invitation: string;
  onInvitationChange: (invitation: string) => void;
  /** Result of validating the invitation, when it is valid. */
  preview?: { id: string; endpoint: string };
  /** The invitation came from a link, so there is nothing to scan or paste. */
  fromLink: boolean;
};

/** Confirms the vault behind a valid invitation before connecting. */
function InvitationPreview({
  busy,
  act,
  invitation,
  preview,
  note,
}: SyncSession & {
  invitation: string;
  preview: { endpoint: string };
  note?: string;
}) {
  const styles = useSyncStyles();
  return (
    <View style={[styles.card, { gap: 10 }]}>
      <Text style={styles.cardTitle}>Conectar ao cofre pessoal</Text>
      <Text style={styles.text}>{new URL(preview.endpoint).host}</Text>
      {note && <Text style={styles.muted}>{note}</Text>}
      <Button
        label="Conectar"
        tone="primary"
        disabled={busy}
        onPress={() => act((c) => c.connectInvitation(invitation))}
      />
    </View>
  );
}

/** Joins an existing vault by QR Code, link or pasted invitation. */
export function InvitationSection({
  title,
  inputRef,
  invitation,
  onInvitationChange,
  preview,
  fromLink,
  ...session
}: InvitationProps & {
  title: string;
  inputRef: React.Ref<React.ComponentRef<typeof TextInput>>;
}) {
  const content = (
    <>
      {!fromLink && (
        <>
          <Button
            label="Escanear QR Code"
            disabled={session.busy}
            onPress={() =>
              session.act(async () =>
                onInvitationChange(await NativeModules.LionPocketPairing.scan()),
              )
            }
          />
          <SyncField
            label="Convite do cofre"
            inputRef={inputRef}
            placeholder="Ou cole o convite do outro aparelho"
            value={invitation}
            onChangeText={onInvitationChange}
          />
        </>
      )}
      {preview && (
        <InvitationPreview
          {...session}
          invitation={invitation}
          preview={preview}
          note="O outro aparelho precisa aprovar seu acesso."
        />
      )}
    </>
  );
  if (fromLink) return content;
  return (
    <SyncCard
      icon="device"
      title={title}
      description="No aparelho conectado, toque em Adicionar aparelho e escaneie o QR Code ou cole o convite aqui."
    >
      {content}
    </SyncCard>
  );
}

/** Waiting for the connected device to approve this one. */
export function PairingProgress({
  invitation,
  onInvitationChange,
  preview,
  fromLink,
  ...session
}: InvitationProps) {
  const styles = useSyncStyles();
  const { status } = session;
  return (
    <SyncCard
      icon="device"
      title={pairingStepTitle(status.pairingStep)}
      description="Confira o mesmo código no aparelho conectado antes de aprovar."
    >
      <View style={styles.field}>
        <Text style={styles.label}>Código de segurança</Text>
        <Text selectable style={styles.code}>
          {status.pairingCode}
        </Text>
      </View>
      {status.pairingError && (
        <SyncNotice tone="error">{status.pairingError}</SyncNotice>
      )}
      {canReplaceInvitation(status.pairingError) && !fromLink && (
        <SyncField
          label="Novo convite do cofre"
          placeholder="Cole um novo convite do aparelho conectado"
          value={invitation}
          onChangeText={onInvitationChange}
        />
      )}
      {preview && preview.id !== status.pairingInviteId && (
        <InvitationPreview {...session} invitation={invitation} preview={preview} />
      )}
    </SyncCard>
  );
}
