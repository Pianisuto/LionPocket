import { serverResetCopy, syncPanelState } from '@lionpocket/sync-local';
import type { ServerResetIntent } from '@lionpocket/sync-local';
import { useState } from 'react';
import { HardDrive, Server } from 'lucide-react';
import { SyncSection } from './primitives';
import { useEndpointDraft, type SyncSession } from './useSyncSession';

/**
 * The previous server was recreated: preserve a backup, unlink, and choose
 * explicitly how this device continues. Changing the choice clears consent.
 */
export function ServerResetForm({ status, busy, run }: SyncSession) {
  const [intent, setIntent] = useState<ServerResetIntent>();
  const [confirmed, setConfirmed] = useState(false);
  const [endpoint, setEndpoint] = useEndpointDraft(status.endpoint);
  return (
    <SyncSection
      icon={Server}
      tone="danger"
      title={serverResetCopy.title}
      description={serverResetCopy.description}
    >
      <fieldset className="sync-reset-choices" disabled={busy}>
        <legend>{serverResetCopy.question}</legend>
        <div className="sync-reset-choices__grid">
          {serverResetCopy.choices.map((choice) => (
            <label key={choice.intent} className="sync-choice sync-reset-choice">
              <input
                type="radio"
                name="server-reset-intent"
                value={choice.intent}
                aria-label={choice.label}
                aria-describedby={`server-reset-${choice.intent}-description`}
                checked={intent === choice.intent}
                onChange={() => {
                  setIntent(choice.intent);
                  setConfirmed(false);
                }}
              />
              <span>
                <strong>{choice.label}</strong>
                <small id={`server-reset-${choice.intent}-description`}>
                  {choice.description}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field sync-reset-endpoint">
        <span>Novo servidor</span>
        <input
          aria-label="Novo servidor"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label className="sync-consent">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || !intent}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>{serverResetCopy.consent}</span>
      </label>
      <div className="sync-actions sync-actions--end sync-reset-footer">
        <button
          className="button button--primary"
          disabled={busy || !intent || !confirmed || !endpoint.trim()}
          onClick={() => void run('server-reset', [endpoint, intent, confirmed])}
        >
          {serverResetCopy.action}
        </button>
      </div>
    </SyncSection>
  );
}

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
