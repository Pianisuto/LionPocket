import { betaActivityLabel } from '@lionpocket/sync-local';
import { useEffect, useState } from 'react';
import type {
  BetaStatus,
  SeriesReview,
  CatalogReview,
  ReviewedSlot,
} from '@lionpocket/sync-local';
import type { PairingRequest } from '@lionpocket/sync-protocol';

export function BetaSyncPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<BetaStatus | null>(null),
    [endpoint, setEndpoint] = useState('https://sync-beta.lionslab.dev'),
    [invitation, setInvitation] = useState(''),
    [fingerprint, setFingerprint] = useState(''),
    [authority, setAuthority] = useState(''),
    [requests, setRequests] = useState<PairingRequest[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [recoveryCode, setRecoveryCode] = useState(''),
    [confirmedCode, setConfirmedCode] = useState(''),
    [revokeId, setRevokeId] = useState('');
  const [series, setSeries] = useState<SeriesReview[]>([]),
    [catalogs, setCatalogs] = useState<CatalogReview[]>([]);
  const refresh = async () => {
    const s = await window.lionPocket.betaSyncStatus?.();
    if (s) {
      setStatus(s);
      setEndpoint(s.endpoint);
      if (s.phase === 'bound') {
        setSeries(
          (await window.lionPocket.betaSyncCommand!(
            'series-reviews',
            [],
          )) as SeriesReview[],
        );
        setCatalogs(
          (await window.lionPocket.betaSyncCommand!(
            'catalog-reviews',
            [],
          )) as CatalogReview[],
        );
      }
    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return window.lionPocket.onBetaSyncChanged?.(() => { void refresh().catch(() => { /* Status remains best effort; local use continues. */ }); });
  }, []);
  const run = async (action: string, args: unknown[] = []) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.lionPocket.betaSyncCommand!(action, args);
      if (action === 'recovery-generate')
        setRecoveryCode((result as { code: string }).code);
      if (action === 'recovery-confirm') {
        setRecoveryCode('');
        setConfirmedCode('');
      }
      if (action === 'inspect')
        setAuthority((result as { fingerprint: string }).fingerprint);
      if (action === 'requests')
        setRequests((result as { requests: PairingRequest[] }).requests);
      await refresh();
      await onChanged();
    } catch (e) {
      setError(String(e));
      await refresh().catch(() => {
        /* Preserve the original operation error. */
      });
    } finally {
      setBusy(false);
    }
  };
  if (!status) return error ? <p role="alert">{error}</p> : null;
  return (
    <section
      className="panel settings-panel sync-beta-panel"
      aria-label="Sincronização da beta privada"
    >
      <h3>Sincronização · Beta privada</h3>
      <p>
        Este perfil mantém uma cópia separada. Você pode continuar usando o
        banco offline. Os dados financeiros enviados são cifrados; o banco e os
        backups locais permanecem em claro.
      </p>
      <p>
        {betaActivityLabel[status.activity]} · Pendentes: {status.sync?.pending ?? 0}
      </p>
      {status.lastCompletedAt && <p>Último sync concluído: {new Date(status.lastCompletedAt).toLocaleString('pt-BR')}</p>}
      <p>Salvo neste aparelho primeiro. Sync automático ao abrir/retomar e após salvar, com o app ativo. “Sincronizar agora” continua disponível.</p>
      {status.phase === 'local' && (
        <>
          <label>
            Servidor HTTPS
            <input
              aria-label="Servidor HTTPS"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
          <button
            disabled={busy}
            onClick={() => void run('configure', [endpoint])}
          >
            Conferir servidor
          </button>
          <h4>Revisão da base antes de conectar</h4>
          <p>
            {Object.entries(status.counts)
              .map(([table, n]) => `${table}: ${n}`)
              .join(' · ')}
          </p>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />{' '}
            Revisei esta cópia. Autorizo o backup anterior à vinculação e o
            envio dos dados elegíveis.
          </label>
          <button
            disabled={busy || !reviewed}
            onClick={() => void run('create')}
          >
            Entrar e criar cofre
          </button>
          <label>
            Convite do outro aparelho
            <textarea
              aria-label="Convite do cofre"
              value={invitation}
              onChange={(e) => {
                setInvitation(e.target.value);
                setAuthority('');
              }}
            />
          </label>
          <button
            disabled={busy || !invitation}
            onClick={() => void run('inspect', [invitation])}
          >
            Conferir autoridade
          </button>
          {authority && (
            <>
              <p>
                Código da autoridade: <code>{authority}</code>
              </p>
              <p>Compare este código no aparelho que criou o cofre.</p>
              <label>
                Código conferido
                <input
                  aria-label="Código da autoridade conferido"
                  value={fingerprint}
                  onChange={(e) => setFingerprint(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !reviewed || fingerprint !== authority}
                onClick={() => void run('pair', [invitation, fingerprint])}
              >
                Entrar e pedir aprovação
              </button>
            </>
          )}
        </>
      )}
      {status.phase === 'local' && authority && (
        <>
          <h4>Recuperar cofre em nova instalação</h4>
          <label>
            Código de recovery
            <input
              type="password"
              autoComplete="off"
              value={confirmedCode}
              onChange={(e) => setConfirmedCode(e.target.value)}
            />
          </label>
          <button
            disabled={busy || fingerprint !== authority || !confirmedCode}
            onClick={() =>
              void run('recover', [invitation, fingerprint, confirmedCode])
            }
          >
            Entrar e recuperar cofre
          </button>
        </>
      )}
      {status.phase === 'creating' && (
        <button disabled={busy} onClick={() => void run('create')}>
          Retomar criação do cofre
        </button>
      )}
      {status.phase === 'pairing' && (
        <>
          <p>
            Código deste aparelho: <code>{status.pairingFingerprint}</code>
          </p>
          <p>Confira e aprove este código no aparelho fundador.</p>
          <button disabled={busy} onClick={() => void run('receive')}>
            Entrar e receber chave aprovada
          </button>
        </>
      )}
      {status.phase === 'bound' && (
        <>
          {status.owner && (
            <>
              <h4>Conectar outro aparelho</h4>
              <label>
                Convite público
                <textarea
                  aria-label="Convite para outro aparelho"
                  readOnly
                  value={status.invitation}
                />
              </label>
              <p>
                Código da autoridade: <code>{status.authorityFingerprint}</code>
              </p>
              <button disabled={busy} onClick={() => void run('requests')}>
                Entrar e buscar pedidos
              </button>
              {requests.map((r) => (
                <div key={r.deviceId}>
                  <p>
                    Aparelho {r.deviceId} · Código: <code>{r.fingerprint}</code>
                  </p>
                  <label>
                    Código mostrado no aparelho
                    <input
                      aria-label={`Código do aparelho ${r.deviceId}`}
                      value={fingerprint}
                      onChange={(e) => setFingerprint(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || fingerprint !== r.fingerprint}
                    onClick={() =>
                      void run('approve', [r.deviceId, fingerprint])
                    }
                  >
                    Aprovar e entregar chave
                  </button>
                </div>
              ))}
            </>
          )}
          {status.restoreReview && (
            <>
              <p>
                Esta cópia foi restaurada. A reconexão exige o mesmo aparelho,
                cofre e epoch. As diferenças locais serão rascunhos; receba e
                revise o remoto antes de liberar envio.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                Revisei a cópia restaurada
              </label>
              <button
                disabled={busy || !reviewed}
                onClick={() => void run('reconnect', [true])}
              >
                Reconectar cópia para revisão
              </button>
            </>
          )}
          <button
            disabled={busy || status.paused || status.restoreReview}
            onClick={() => void run('sync')}
          >
            {busy ? 'Aguarde…' : 'Sincronizar agora'}
          </button>
          <button
            disabled={busy}
            onClick={() => void run('pause', [!status.paused])}
          >
            {status.paused
              ? 'Retomar sincronização'
              : 'Pausar mantendo pendências'}
          </button>
          {status.joiningReview && (
            <>
              <h4>Combinar bases preenchidas</h4>
              <p>
                Sincronize para receber e revisar a base remota. Cadastros com o
                mesmo nome exigem decisão explícita. Identidades e lançamentos
                locais distintos permanecem distintos.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                Revisei as duas bases e desejo conservar seus registros
                distintos.
              </label>
              <button
                disabled={busy || !reviewed || !!status.quarantine.length}
                onClick={() => void run('confirm')}
              >
                Confirmar combinação e liberar envio
              </button>
            </>
          )}
          {status.owner && (
            <>
              <h4>Recuperação e proteção</h4>
              <p>
                Versão da chave: {status.activeKeyVersion} · Recovery
                confirmado: {status.recoveryVersion !== '0' ? 'Sim' : 'Não'}
              </p>
              <button
                disabled={busy}
                onClick={() => void run('recovery-generate')}
              >
                Gerar código de recovery
              </button>
              {recoveryCode && (
                <>
                  <p>
                    Guarde este segredo fora do app. Ele recupera o conteúdo e a
                    autoridade do cofre.
                  </p>
                  <code>{recoveryCode}</code>
                  <label>
                    Digite o código guardado
                    <input
                      type="password"
                      autoComplete="off"
                      value={confirmedCode}
                      onChange={(e) => setConfirmedCode(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || confirmedCode !== recoveryCode}
                    onClick={() =>
                      void run('recovery-confirm', [confirmedCode])
                    }
                  >
                    Confirmar posse e ativar recovery
                  </button>
                </>
              )}
              <button disabled={busy} onClick={() => void run('rotate')}>
                Rotacionar chave e retomar operação pendente
              </button>
              <label>
                ID do aparelho a revogar
                <input
                  value={revokeId}
                  onChange={(e) => setRevokeId(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !revokeId}
                onClick={() => void run('revoke', [revokeId, revokeId])}
              >
                Revogar aparelho e rotacionar chave
              </button>
            </>
          )}
          <h4>Dispositivos</h4>
          {status.devices.map((d) => (
            <p key={d.registryVersion}>
              {d.deviceId} · {d.status}
            </p>
          ))}
          {status.sync?.conflicts.map((c) => (
            <div key={c.objectId}>
              <h4>Conflito financeiro</h4>
              <p>{c.objectId}</p>
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
                      void run('resolve', [
                        c.objectId,
                        c.heads,
                        b.revisionId,
                        c.deleted && b.revision.action === 'put',
                      ])
                    }
                  >
                    {c.deleted && b.revision.action === 'put'
                      ? 'Recuperar como novo registro'
                      : b.revision.action === 'delete'
                        ? 'Confirmar exclusão'
                        : 'Usar esta versão'}
                  </button>
                </div>
              ))}
            </div>
          ))}
          {series.map((s) => (
            <SeriesReviewForm
              key={s.localId}
              series={s}
              busy={busy}
              submit={(slots) =>
                run('series-review', [s.entityType, s.localId, slots])
              }
            />
          ))}
          {!!catalogs.length && (
            <CatalogBatchReview
              catalogs={catalogs}
              busy={busy}
              submit={(suffix) => run('catalog-batch', [suffix, true])}
            />
          )}
          {catalogs.map((c) => (
            <CatalogReviewForm
              key={c.commitId + c.objectId}
              review={c}
              busy={busy}
              submit={(name) =>
                run('catalog-separate', [c.commitId, c.objectId, name])
              }
            />
          ))}
          {status.reviews
            .filter(
              (r) =>
                r.reason === 'import_provenance_review' ||
                (r.reason === 'legacy_delete_review'||r.reason==='restored_missing_record'),
            )
            .map((r) => (
              <div key={String(r.review_id)}>
                <p>
                  {r.reason === 'import_provenance_review'
                    ? 'Origem importada antiga sem proveniência verificável. A conversão manual conserva a origem anterior na auditoria.'
                    : 'Exclusão antiga sem data verificável.'}{' '}
                  {String(r.object_id)}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      r.reason === 'import_provenance_review'
                        ? 'import-review'
                        : 'delete-review',
                      [r.object_id, true],
                    )
                  }
                >
                  {r.reason === 'import_provenance_review'
                    ? 'Confirmar conversão para lançamento manual'
                    : 'Confirmar exclusão agora'}
                </button>
              </div>
            ))}
          {status.reviews.map((r) => (
            <p key={String(r.review_id)}>
              Revisão necessária: {String(r.reason)} · {String(r.object_id)}
            </p>
          ))}
          {status.quarantine.map((q) => (
            <p key={String(q.commit_id)}>
              Recebimento preservado para revisão: {String(q.last_error)}
            </p>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function CatalogReviewForm({
  review,
  busy,
  submit,
}: {
  review: CatalogReview;
  busy: boolean;
  submit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  return (
    <div>
      <h4>Cadastros distintos com o mesmo nome</h4>
      <p>
        {review.entityType}: {review.remoteName}. Confira os cadastros. Escolha
        um nome distinto para o local; o remoto conserva o nome recebido e suas
        referências.
      </p>
      <label>
        Novo nome local
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button
        disabled={busy || !name.trim() || name.trim() === review.remoteName}
        onClick={() => void submit(name)}
      >
        Conservar ambos separadamente
      </button>
    </div>
  );
}
function SeriesReviewForm({
  series,
  busy,
  submit,
}: {
  series: SeriesReview;
  busy: boolean;
  submit: (slots: ReviewedSlot[]) => Promise<void>;
}) {
  const [choices, setChoices] = useState<ReviewedSlot[]>(() =>
      series.slots.map((t) => ({
        localId: t.localId,
        originalDate: '',
        slotKey: '',
        originalIndex: null,
        publish: false,
      })),
    ),
    [confirmed, setConfirmed] = useState(false);
  const change = (i: number, patch: Partial<ReviewedSlot>) =>
    setChoices((old) => old.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  return (
    <div>
      <h4>Revisar série antiga: {series.description}</h4>
      <p>
        Confira no histórico a data original de cada ocorrência. A data atual
        pode ter sido editada. Slots mensais usam monthly:AAAA-MM; outros usam
        uma chave única escolhida após conferir o histórico. Parcelas exigem a
        posição original, antes de qualquer renumeração.
      </p>
      {series.slots.map((t, i) => (
        <div key={t.localId}>
          <p>
            {t.description} · {t.status} · data atual {t.currentDate} · parcela
            atual {t.installmentNumber ?? '—'}
          </p>
          <label>
            Data original
            <input
              type="date"
              value={choices[i].originalDate}
              onChange={(e) => change(i, { originalDate: e.target.value })}
            />
          </label>
          <label>
            Chave original do slot
            <input
              value={choices[i].slotKey}
              onChange={(e) => change(i, { slotKey: e.target.value })}
            />
          </label>
          {series.entityType === 'installmentPurchase' && (
            <label>
              Posição original
              <input
                type="number"
                min="1"
                value={choices[i].originalIndex ?? ''}
                onChange={(e) =>
                  change(i, { originalIndex: Number(e.target.value) })
                }
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={choices[i].publish}
              onChange={(e) => change(i, { publish: e.target.checked })}
            />{' '}
            Enviar também esta ocorrência editada ou realizada
          </label>
        </div>
      ))}
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        Conferi todas as identidades no histórico
      </label>
      <button
        disabled={
          busy ||
          !confirmed ||
          choices.some(
            (c) =>
              !c.originalDate ||
              !c.slotKey ||
              (series.entityType === 'installmentPurchase' && !c.originalIndex),
          )
        }
        onClick={() => void submit(choices)}
      >
        Confirmar identidades e liberar série
      </button>
    </div>
  );
}

function CatalogBatchReview({
  catalogs,
  busy,
  submit,
}: {
  catalogs: CatalogReview[];
  busy: boolean;
  submit: (suffix: string) => Promise<void>;
}) {
  const [suffix, setSuffix] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  return (
    <div>
      <h4>Revisar a lista de cadastros</h4>
      <p>
        {catalogs.map((c) => c.entityType + ': ' + c.localName).join(' · ')}
      </p>
      <p>
        Conservar ambos mantém identidades e referências distintas. Todos os
        cadastros locais desta lista receberão o sufixo informado.
      </p>
      <label>
        Sufixo para nomes locais
        <input value={suffix} onChange={(e) => setSuffix(e.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        Conferi a lista e desejo conservar os cadastros distintos
      </label>
      <button
        disabled={busy || !confirmed || !suffix.trim()}
        onClick={() => void submit(suffix)}
      >
        Conservar a lista separadamente
      </button>
    </div>
  );
}
