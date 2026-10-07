import { revisionSummary } from '@lionpocket/sync-local';
import { useState } from 'react';
import { CircleAlert, ShieldCheck, Stethoscope } from 'lucide-react';
import { SyncDisclosure, SyncNotice, SyncSection } from './primitives';
import type { SyncSession } from './useSyncSession';

/** Decisions the user must take before sync can finish. */
export function SyncReviews({ status, busy, run }: SyncSession) {
  const [reviewed, setReviewed] = useState(false);
  return (
    <>
      {status.restoreReview && (
        <SyncSection
          icon={ShieldCheck}
          title="Revise a cópia restaurada"
          description="A reconexão exige o mesmo aparelho, cofre e histórico do servidor. As diferenças locais serão rascunhos: receba e revise os dados remotos antes de liberar o envio."
        >
          <label className="sync-consent">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            <span>Revisei a cópia restaurada</span>
          </label>
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy || !reviewed}
              onClick={() => void run('reconnect', [true])}
            >
              Reconectar para revisão
            </button>
          </div>
        </SyncSection>
      )}
      {status.sync?.conflicts.map((c) => (
        <SyncSection
          key={c.objectId}
          icon={CircleAlert}
          title="Escolha a versão deste registro"
          description="Este lançamento foi alterado em mais de um aparelho. Compare as informações e escolha qual versão conservar."
        >
          <div className="sync-conflict-grid">
            {c.branches.map((b) => {
              const summary = revisionSummary(b.revision);
              const restore = c.deleted && b.revision.action === 'put';
              return (
                <div className="sync-conflict" key={b.revisionId}>
                  <h5>{summary.title}</h5>
                  {summary.lines.map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
                  <small>
                    Alterado em{' '}
                    {new Date(b.revision.authoredAt).toLocaleString('pt-BR')}
                  </small>
                  <details className="sync-technical">
                    <summary>Detalhes desta versão</summary>
                    <pre>{JSON.stringify(b.revision, null, 2)}</pre>
                  </details>
                  <button
                    className="button button--soft"
                    disabled={busy}
                    onClick={() =>
                      void run('resolve', [c.objectId, c.heads, b.revisionId, restore])
                    }
                  >
                    {restore
                      ? 'Recuperar como novo registro'
                      : b.revision.action === 'delete'
                        ? 'Confirmar exclusão'
                        : 'Usar esta versão'}
                  </button>
                </div>
              );
            })}
          </div>
        </SyncSection>
      ))}
      {status.reviews
        .filter((r) => r.reason === 'restored_missing_record')
        .map((r) => (
          <SyncSection
            key={String(r.review_id)}
            icon={CircleAlert}
            title="Confira um registro ausente na cópia restaurada"
          >
            <p>
              A cópia restaurada não contém este registro. Confirme a exclusão
              somente se você deseja removê-lo também dos outros aparelhos.
            </p>
            <details className="sync-technical">
              <summary>Identificador do registro</summary>
              <code>{String(r.object_id)}</code>
            </details>
            <div className="sync-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => void run('delete-review', [r.object_id, true])}
              >
                Confirmar exclusão agora
              </button>
            </div>
          </SyncSection>
        ))}
      {!!(status.reviews.length || status.quarantine.length) && (
        <SyncNotice title="Há informações para revisar" tone="warning">
          {!!status.reviews.length &&
            `${status.reviews.length} registro(s) precisam de revisão antes de concluir a sincronização. `}
          {!!status.quarantine.length &&
            'Alguns recebimentos foram preservados para revisão. Seus dados locais continuam disponíveis.'}
        </SyncNotice>
      )}
    </>
  );
}

/** Technical identifiers, collapsed by default. */
export function SyncDiagnostics({ status }: SyncSession) {
  if (!status.reviews.length && !status.quarantine.length) return null;
  return (
    <SyncDisclosure
      icon={Stethoscope}
      title="Diagnóstico das revisões"
      description="Identificadores técnicos das revisões e recebimentos preservados."
    >
      {status.reviews.map((r) => (
        <p key={String(r.review_id)} className="sync-identifier">
          {String(r.reason)} · {String(r.object_id)}
        </p>
      ))}
      {status.quarantine.map((q) => (
        <p key={String(q.commit_id)} className="sync-identifier">
          {String(q.last_error)}
        </p>
      ))}
    </SyncDisclosure>
  );
}
