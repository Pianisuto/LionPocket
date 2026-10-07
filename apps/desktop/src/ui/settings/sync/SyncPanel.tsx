import { syncPanelState } from '@lionpocket/sync-local';
import { useRef } from 'react';
import { LockKeyhole } from 'lucide-react';
import { DevicesSection } from './Devices';
import { InvitationSection, PairingProgress } from './Pairing';
import { SyncGroupLabel, SyncNotice } from './primitives';
import { ProtectionSection } from './Protection';
import { ServerRecovery } from './ServerRecovery';
import { ServerResetContinuation, ServerResetForm } from './ServerReset';
import { SyncOverview } from './SyncOverview';
import { SyncDiagnostics, SyncReviews } from './SyncReviews';
import { RecoverVault, ResumeVaultCreation, SyncSetup } from './SyncSetup';
import { useSyncSession, type SyncSession } from './useSyncSession';

/**
 * Sync settings, composed by phase: overview and pending decisions first,
 * then setup or devices, and the rare recreated-server flow at the end.
 */
export function SyncPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const { status, busy, error, run, setError } = useSyncSession(onChanged);
  const invitationInput = useRef<HTMLTextAreaElement>(null);
  if (!status) return error ? <p role="alert">{error}</p> : null;

  const session: SyncSession = { status, busy, run, setError };
  const view = syncPanelState(status);
  const local = status.phase === 'local';

  return (
    <div className="sync-panel" role="region" aria-label="Sincronização">
      <SyncOverview {...session} />

      {status.compatibilityMessage && (
        <SyncNotice title="A sincronização precisa da sua atenção" tone="warning">
          {status.compatibilityMessage}
        </SyncNotice>
      )}
      {error && (
        <SyncNotice title="Não foi possível concluir esta ação" tone="error">
          {error}
        </SyncNotice>
      )}

      {view.showServerRecovery && <ServerRecovery {...session} />}
      {view.canManage && <SyncReviews {...session} />}

      {local && view.resetReady && (
        <ServerResetContinuation
          {...session}
          onConnectByInvite={() => {
            invitationInput.current?.focus();
            invitationInput.current?.scrollIntoView?.({ block: 'center' });
          }}
        />
      )}
      {local && status.pairingStep === 'preparing' && (
        <p role="status">Preparando conexão…</p>
      )}
      {local && !view.resetReady && <SyncSetup {...session} />}
      {local && (
        <>
          <InvitationSection
            {...session}
            inputRef={invitationInput}
            title={view.joiningRecreated ? 'Conectar ao cofre já recriado' : 'Colar convite'}
          />
          <RecoverVault {...session} />
        </>
      )}
      {status.phase === 'creating' && <ResumeVaultCreation {...session} />}
      {status.phase === 'pairing' && <PairingProgress {...session} />}

      {view.canManage && (
        <div className="sync-management">
          <DevicesSection {...session} />
          {status.owner && <ProtectionSection {...session} />}
          <SyncDiagnostics {...session} />
        </div>
      )}

      {view.connected && (
        <>
          <SyncGroupLabel>Ações avançadas</SyncGroupLabel>
          <ServerResetForm {...session} />
        </>
      )}

      <footer className="sync-panel__footnote">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>
          O LionPocket salva primeiro neste aparelho. A sincronização envia
          conteúdo criptografado enquanto o aplicativo está aberto. O servidor
          não recebe seus dados financeiros em claro.
        </span>
      </footer>
    </div>
  );
}
