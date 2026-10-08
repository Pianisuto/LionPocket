import { syncPanelState } from '@lionpocket/sync-local';
import { HardDrive } from 'lucide-react';
import { SyncSection } from './primitives';
import { type SyncSession } from './useSyncSession';

/** After unlinking: create the new vault here, or join the recreated one. */
export function ServerResetContinuation({
  status,
  busy,
  run,
  onConnectByInvite,
}: SyncSession & { onConnectByInvite: () => void }) {
  const { creatingFromReset, joiningRecreated } = syncPanelState(status);
  return (
    <SyncSection icon={HardDrive} title="Banco local preservado">
      <p>Backup criado: {status.serverReset!.backupPath}</p>
      {creatingFromReset && (
        <>
          <p>
            Este aparelho foi escolhido como fonte de verdade. Crie o novo cofre
            usando seus dados locais.
          </p>
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => void run('create')}
            >
              Criar novo cofre usando estes dados
            </button>
          </div>
        </>
      )}
      {joiningRecreated && (
        <>
          <p>
            Use o convite do aparelho que já recriou o cofre. Abra o link LPV2
            neste computador ou cole o convite abaixo. Este aparelho pedirá
            acesso e aguardará aprovação.
          </p>
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy}
              onClick={onConnectByInvite}
            >
              Conectar por convite
            </button>
          </div>
        </>
      )}
    </SyncSection>
  );
}
