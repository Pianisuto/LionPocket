import { useEffect, useState } from 'react';
import type { DevelopmentSyncStatus } from '@lionpocket/sync-local';
export function DevelopmentSync({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<DevelopmentSyncStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.lionPocket
      .developmentSyncStatus?.()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  const run = async (
    action: () => Promise<DevelopmentSyncStatus | undefined>,
  ) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (next) setStatus(next);
      await onChanged();
    } catch (e) {
      setError(String(e));
      setStatus((await window.lionPocket.developmentSyncStatus?.()) ?? null);
    } finally {
      setBusy(false);
    }
  };
  if (!status) return error ? <p role="alert">{error}</p> : null;
  return (
    <div className="panel settings-panel">
      <h3>Sync sintético de desenvolvimento</h3>
      <p>
        Somente lançamentos manuais sem vínculos. Recebido: {status.received} ·
        Aplicado: {status.applied} · Pendentes: {status.pending} · Quarentena:{' '}
        {status.quarantined}
      </p>
      <button
        disabled={busy || !status.enabled}
        onClick={() => void run(() => window.lionPocket.developmentSyncRun!())}
      >
        Entrar e sincronizar agora
      </button>
      {error && <p role="alert">{error}</p>}
      {status.conflicts.map((c) => (
        <div key={c.objectId}>
          <h4>Revisar conflito {c.objectId}</h4>
          <p>Heads revisados: {c.heads.join(', ')}</p>
          {c.branches.map((b) => (
            <div key={b.revisionId}>
              <pre>
                {JSON.stringify(
                  b.revision.action === 'put'
                    ? b.revision.snapshot
                    : { action: 'delete' },
                  null,
                  2,
                )}
              </pre>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    window.lionPocket.developmentSyncResolve!(
                      c.objectId,
                      c.heads,
                      b.revisionId,
                      c.deleted && b.revision.action === 'put',
                    ),
                  )
                }
              >
                {c.deleted && b.revision.action === 'put'
                  ? 'Recuperar como novo lançamento'
                  : b.revision.action === 'delete'
                    ? 'Confirmar exclusão'
                    : 'Usar este ramo'}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
