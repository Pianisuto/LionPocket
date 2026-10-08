import { syncPanelState } from '@lionpocket/sync-local';
import { useRef } from 'react';
import { LockKeyhole } from 'lucide-react';
import { DevicesSection } from './Devices';
import { InvitationSection, PairingProgress } from './Pairing';
import { SyncNotice } from './primitives';
import { ProtectionSection } from './Protection';
import { ServerRecovery } from './ServerRecovery';
import { ServerResetContinuation } from './ServerReset';
import { UnlinkServer } from './UnlinkServer';
import { SyncOverview } from './SyncOverview';
import { SyncDiagnostics, SyncReviews } from './SyncReviews';
import { RecoverVault, ResumeVaultCreation, SyncSetup } from './SyncSetup';
import { useSyncSession, type SyncSession } from './useSyncSession';

/**
 * Sync settings, composed by phase: overview and pending decisions first,
 * then setup or devices, with recovery tools side by side below the devices.
 */
export function SyncPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const { status, busy, error, run, setError } = useSyncSession(onChanged);
  const invitationInput = useRef<HTMLTextAreaElement>(null);
  if (!status) return error ? <p role="alert">{error}</p> : null;

  const session: SyncSession = { status, busy, run, setError };
  const view = syncPanelState(status);
  const local = status.phase === 'local' && !status.unlinkPending;

  return (
    <div className="sync-panel" role="region" aria-label="Sincronização">
      <SyncOverview {...session} />
      {view.canUnlink && <UnlinkServer {...session} />}

      {status.compatibilityMessage && (
        <SyncNotice
          title="A sincronização precisa da sua atenção"
          tone="warning"
        >
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
      {local && !view.resetReady && (
        <SyncSetup {...session} inputRef={invitationInput} />
      )}
      {local && view.resetReady && (
        <InvitationSection
          {...session}
          inputRef={invitationInput}
          title={
            view.joiningRecreated
              ? 'Conectar ao cofre já recriado'
              : 'Colar convite'
          }
        />
      )}
      {local && <RecoverVault {...session} />}
      {!status.unlinkPending && status.phase === 'creating' && (
        <ResumeVaultCreation {...session} />
      )}
      {!status.unlinkPending && status.phase === 'pairing' && (
        <PairingProgress {...session} />
      )}

      {view.connected && (
        <div className="sync-management">
          {view.canManage && <DevicesSection {...session} />}
          {view.canManage && status.owner && (
            <div className="sync-management__tools">
              <div className="sync-management__protection">
                <ProtectionSection {...session} />
              </div>
            </div>
          )}
          {view.canManage && <SyncDiagnostics {...session} />}
        </div>
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
