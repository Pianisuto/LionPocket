import {
  syncPanelState,
  syncStatusDescription,
  syncStatusTitle,
} from '@lionpocket/sync-local';
import {
  CheckCheck,
  CircleAlert,
  CloudOff,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Server,
  Vault,
} from 'lucide-react';
import type { SyncSession } from './useSyncSession';

/** Current state of this device and the everyday sync actions. */
export function SyncOverview({ status, busy, run }: SyncSession) {
  const { connected, canManage, needsAttention } = syncPanelState(status);
  const StatusIcon =
    status.phase === 'local'
      ? HardDrive
      : status.activity === 'paused'
        ? Pause
        : status.activity === 'unavailable'
          ? CloudOff
          : needsAttention
            ? CircleAlert
            : ['synced', 'ready'].includes(status.activity)
              ? CheckCheck
              : RefreshCw;

  return (
    <div
      className={`sync-overview ${needsAttention ? 'is-attention' : connected ? 'is-connected' : ''}`}
    >
      <div className="sync-overview__main">
        <div className="sync-overview__state" role="status" aria-live="polite">
          <span className="sync-overview__icon">
            <StatusIcon
              size={22}
              aria-hidden="true"
              className={status.activity === 'syncing' ? 'sync-spinning' : ''}
            />
          </span>
          <div>
            <strong>{syncStatusTitle(status)}</strong>
            <p>{syncStatusDescription(status)}</p>
          </div>
        </div>
        {canManage && (
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy || status.paused || status.restoreReview}
              onClick={() => void run('sync')}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {busy ? 'Aguarde…' : 'Sincronizar agora'}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void run('pause', [!status.paused])}
            >
              {status.paused ? (
                <Play size={15} aria-hidden="true" />
              ) : (
                <Pause size={15} aria-hidden="true" />
              )}
              {status.paused ? 'Retomar' : 'Pausar'}
            </button>
          </div>
        )}
      </div>

      {connected && (
        <dl className="sync-connection">
          <div>
            <dt>
              <Server size={14} aria-hidden="true" />
              Servidor
            </dt>
            <dd>
              {status.endpoint ? new URL(status.endpoint).host : 'Não informado'}
            </dd>
          </div>
          <div>
            <dt>
              <CheckCheck size={14} aria-hidden="true" />
              Última sincronização
            </dt>
            <dd>
              {status.lastCompletedAt
                ? new Date(status.lastCompletedAt).toLocaleString('pt-BR')
                : 'Ainda não concluída'}
            </dd>
          </div>
          <div>
            <dt>
              <Vault size={14} aria-hidden="true" />
              Cofre
            </dt>
            <dd role="status">
              {status.lastCompletedAt
                ? 'Sincronização pronta'
                : 'Sincronizando dados…'}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
