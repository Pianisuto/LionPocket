import { syncPanelState } from '@lionpocket/sync-local';
import React, { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { DevicesSection } from './Devices';
import { SyncCard, SyncGroupLabel, SyncNotice, useSyncStyles } from './kit';
import { InvitationSection, PairingProgress } from './Pairing';
import { ProtectionSection } from './Protection';
import { ServerRecovery } from './ServerRecovery';
import { ServerResetContinuation, ServerResetForm } from './ServerReset';
import { SyncOverview } from './SyncOverview';
import { SyncDiagnostics, SyncReviews } from './SyncReviews';
import { RecoverVault, ResumeVaultCreation, SyncSetup } from './SyncSetup';
import {
  useInvitationPreview,
  useSyncSession,
  type SyncSession,
} from './useSyncSession';

/**
 * Sync settings, composed by phase: overview and pending decisions first,
 * then setup or devices, and the rare recreated-server flow at the end.
 * With `initialInvitation` (opened from a link) it shows only the pairing path.
 */
export function SyncPanel({
  onChanged,
  initialInvitation,
}: {
  onChanged: () => Promise<void>;
  initialInvitation?: string;
}) {
  const styles = useSyncStyles();
  const { status, busy, error, act, setError } = useSyncSession(onChanged);
  const [invitation, setInvitation] = useState(initialInvitation ?? '');
  const preview = useInvitationPreview(invitation, setError);
  const invitationInput = useRef<React.ComponentRef<typeof TextInput>>(null);
  if (!status)
    return (
      <Text accessibilityRole="alert" style={styles.muted}>
        {error || 'Carregando sincronização…'}
      </Text>
    );

  const session: SyncSession = { status, busy, act, setError };
  const view = syncPanelState(status);
  const local = status.phase === 'local';
  const fromLink = !!initialInvitation;
  const invitationProps = {
    ...session,
    invitation,
    onInvitationChange: setInvitation,
    preview,
    fromLink,
  };

  return (
    <View style={styles.panel}>
      {fromLink && local ? (
        <SyncCard
          icon="device"
          title="Conectar aparelho"
          description="Seu acesso será liberado depois da aprovação no aparelho conectado."
        />
      ) : (
        <SyncOverview {...session} />
      )}

      {status.compatibilityMessage && (
        <SyncNotice tone="warning" title="A sincronização precisa da sua atenção">
          {status.compatibilityMessage}
        </SyncNotice>
      )}
      {!!error && (
        <SyncNotice tone="error" title="Não foi possível concluir esta ação">
          {error}
        </SyncNotice>
      )}

      {view.showServerRecovery && <ServerRecovery {...session} />}
      {view.canManage && <SyncReviews {...session} />}

      {local && view.resetReady && (
        <ServerResetContinuation
          {...session}
          onConnectByInvite={() => invitationInput.current?.focus()}
        />
      )}
      {local && status.pairingStep === 'preparing' && (
        <Text style={styles.text}>Preparando conexão…</Text>
      )}
      {local && !view.resetReady && !invitation && (
        <SyncSetup {...session} direct={fromLink} />
      )}
      {local && (
        <InvitationSection
          {...invitationProps}
          inputRef={invitationInput}
          title={
            view.joiningRecreated
              ? 'Conectar ao cofre já recriado'
              : 'Entrar em um cofre existente'
          }
        />
      )}
      {local && !fromLink && <RecoverVault {...session} />}
      {status.phase === 'creating' && <ResumeVaultCreation {...session} />}
      {status.phase === 'pairing' && <PairingProgress {...invitationProps} />}

      {view.canManage && (
        <>
          <DevicesSection {...session} />
          {status.owner && <ProtectionSection {...session} />}
          <SyncDiagnostics {...session} />
        </>
      )}

      {view.connected && (
        <>
          <SyncGroupLabel>Ações avançadas</SyncGroupLabel>
          <ServerResetForm {...session} />
        </>
      )}

      {!fromLink && (
        <Text style={styles.muted}>
          O LionPocket salva primeiro neste aparelho. A sincronização envia
          conteúdo criptografado enquanto o aplicativo está ativo. O servidor
          não recebe seus dados financeiros em claro.
        </Text>
      )}
    </View>
  );
}
