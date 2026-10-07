import {
  syncActivityLabel,
  revisionSummary,
  pairingQr,
} from '@lionpocket/sync-local';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  CloudOff,
  HardDrive,
  KeyRound,
  Link2,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ServerResetIntent, SyncStatus } from '@lionpocket/sync-local';
import { pairingErrorMessage } from '@lionpocket/sync-protocol';

const recoveryFinalizing = [
  'activation_requested',
  'remote_active',
  'installing_local',
  'local_db_installed',
  'profile_installed',
  'finalizing',
];

export function SyncPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [invitation, setInvitation] = useState('');
  const [recoveryPackage, setRecoveryPackage] = useState('');
  const [inviteInfo, setInviteInfo] = useState<{
    id: string;
    endpoint: string;
  }>();
  const [pairingLink, setPairingLink] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const invitationInput = useRef<HTMLTextAreaElement>(null);
  const [resetIntent, setResetIntent] = useState<ServerResetIntent>();
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [setup, setSetup] = useState(false);

  const refresh = async () => {
    const s = await window.lionPocket.syncStatus?.();
    if (s) {
      setStatus(s);
      setEndpoint(s.endpoint);
    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(pairingErrorMessage(e)));
    return window.lionPocket.onSyncChanged?.(() => {
      void refresh().catch(() => {
        /* Local use continues if status is unavailable. */
      });
    });
  }, []);
  const run = async (action: string, args: unknown[] = []) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.lionPocket.syncCommand!(action, args);
      if (
        action === 'server-recovery-prepare' &&
        (result as { code?: string }).code
      ) {
        setRecoveryCode((result as { code: string }).code);
      }
      if (action === 'recovery-generate')
        setRecoveryCode((result as { code: string }).code);
      if (
        action === 'recovery-confirm' ||
        action === 'server-recovery-confirm'
      ) {
        setRecoveryCode('');
        setConfirmedCode('');
      }
      if (action === 'invite-create') {
        setPairingLink((result as { link: string }).link);
        setAdding(true);
      }
      if (
        action === 'approve' ||
        action === 'invite-revoke' ||
        action === 'pairing-deny'
      ) {
        setAdding(false);
        setPairingLink('');
      }
      await refresh();
      await onChanged();
    } catch (e) {
      setError(pairingErrorMessage(e));
      await refresh().catch(() => {
        /* Preserve the operation error. */
      });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    setInviteInfo(undefined);
    if (invitation.trim())
      void window.lionPocket.syncCommand!('pairing-inspect', [invitation])
        .then((info) => {
          if (!cancelled) {
            setInviteInfo(info as { id: string; endpoint: string });
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(pairingErrorMessage(e));
        });
    return () => {
      cancelled = true;
    };
  }, [invitation]);
  if (!status) return error ? <p role="alert">{error}</p> : null;

  const resetReady = status.phase === 'local' && status.serverReset?.phase === 'ready';
  const joiningRecreated = resetReady && status.serverReset?.intent === 'join-existing';
  const connected = status.phase === 'bound';
  const canManage =
    connected &&
    (!status.recoveryPhase || status.recoveryPhase === 'recovered');
  const pending = status.sync?.pending ?? 0;
  const needsAttention = [
    'paused',
    'unavailable',
    'review',
    'action-required',
  ].includes(status.activity);
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
  const statusTitle =
    status.activity === 'paused'
      ? 'Sincronização pausada'
      : syncActivityLabel[status.activity];
  const statusDescription =
    status.phase === 'local'
      ? 'Funciona sem conta e sem conexão com a internet.'
      : pending
        ? `${pending} ${pending === 1 ? 'alteração aguardando envio' : 'alterações aguardando envio'}. Seus dados já estão salvos neste aparelho.`
        : status.activity === 'unavailable'
          ? 'Seus dados continuam disponíveis. A sincronização pode ser retomada quando a conexão voltar.'
          : status.activity === 'paused'
            ? 'Você pode continuar usando o aplicativo e retomar quando quiser.'
            : status.activity === 'review'
              ? 'Confira as informações abaixo antes de concluir a sincronização.'
              : status.activity === 'action-required'
                ? 'Entre novamente ou desbloqueie as chaves para continuar.'
                : connected
                  ? 'Nenhuma alteração aguardando envio.'
                  : 'Siga as etapas abaixo para conectar este aparelho.';

  return (
    <section
      className="panel settings-panel settings-panel--wide sync-panel"
      aria-label="Sincronização"
    >
      <header className="panel__header">
        <div className="settings-icon">
          <RefreshCw size={20} aria-hidden="true" />
        </div>
        <div>
          <h3>Sincronização</h3>
          <p>Seus dados em mais de um aparelho, com você no controle.</p>
        </div>
        <span className="sync-panel__privacy-badge">
          <LockKeyhole size={13} aria-hidden="true" />
          Criptografia de ponta a ponta
        </span>
      </header>

      <div
        className={`sync-overview ${needsAttention ? 'is-attention' : connected ? 'is-connected' : ''}`}
      >
        <div className="sync-overview__main">
          <div
            className="sync-overview__state"
            role="status"
            aria-live="polite"
          >
            <span className="sync-overview__icon">
              <StatusIcon
                size={22}
                aria-hidden="true"
                className={status.activity === 'syncing' ? 'sync-spinning' : ''}
              />
            </span>
            <div>
              <strong>{statusTitle}</strong>
              <p>{statusDescription}</p>
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
                {status.endpoint
                  ? new URL(status.endpoint).host
                  : 'Não informado'}
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
          </dl>
        )}
      </div>

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

      {(status.recoveryPhase ||
        (status.anchorRecoveryAvailable &&
          status.compatibilityMessage?.includes('histórico'))) && (
        <SyncSection
          icon={ShieldCheck}
          title={
            status.recoveryPhase === 'recovered'
              ? 'Sincronização recuperada'
              : status.recoveryPhase === 'prepared'
                ? 'Pronto para ativar'
                : recoveryFinalizing.includes(status.recoveryPhase ?? '')
                  ? 'Finalizando a recuperação'
                  : 'Recuperar sincronização'
          }
          description={
            status.recoveryPhase === 'recovered'
              ? 'Este aparelho está pronto para sincronizar novamente.'
              : 'Seus dados locais estão preservados. Mantenha este aparelho aberto durante a recuperação.'
          }
        >
          {!status.recoveryPhase && (
            <div className="sync-actions">
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void run('server-recovery-prepare', [true])}
              >
                Preparar recuperação
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {status.recoveryPhase &&
            !['prepared', ...recoveryFinalizing, 'recovered'].includes(
              status.recoveryPhase,
            ) && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void run('server-recovery-prepare', [true])}
              >
                Continuar preparação
              </button>
            )}
          {status.recoveryPhase === 'recovery_pending_confirmation' &&
            recoveryCode && (
              <RecoveryCode
                code={recoveryCode}
                confirmed={confirmedCode}
                onConfirmChange={setConfirmedCode}
                busy={busy}
                confirmLabel="Guardei e conferi o código"
                onConfirm={() =>
                  void run('server-recovery-confirm', [confirmedCode])
                }
              />
            )}
          {status.recoveryPhase === 'prepared' && (
            <>
              <p>
                O servidor passará a usar os dados reconstruídos deste aparelho
                como a nova base de sincronização.
              </p>
              <div className="sync-actions">
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void run('server-recovery-activate', [true])}
                >
                  Ativar sincronização recuperada
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </>
          )}
          {recoveryFinalizing.includes(status.recoveryPhase ?? '') && (
            <div className="sync-actions">
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void run('server-recovery-activate')}
              >
                Continuar finalização
              </button>
            </div>
          )}
        </SyncSection>
      )}

      {status.phase === 'bound' && (
        <SyncSection
          icon={Server}
          title="Servidor de sincronização recriado"
          description="O remoto anterior será abandonado. Um backup completo será criado antes de remover o vínculo. Seus dados financeiros locais não serão apagados."
        >
          <fieldset className="sync-reset-choices" disabled={busy}>
            <legend>Como este aparelho deve continuar?</legend>
            <div className="sync-reset-choices__grid">
              <label className="sync-choice sync-reset-choice">
                <input
                  type="radio"
                  name="server-reset-intent"
                  value="source-of-truth"
                  aria-label="Usar este aparelho como fonte de verdade"
                  aria-describedby="server-reset-source-description"
                  checked={resetIntent === 'source-of-truth'}
                  onChange={() => {
                    setResetIntent('source-of-truth');
                    setResetConfirmed(false);
                  }}
                />
                <span>
                  <strong>Usar este aparelho como fonte de verdade</strong>
                  <small id="server-reset-source-description">
                    Depois do backup e da desvinculação, crie um novo cofre usando
                    os dados deste aparelho. Usar esta opção em mais de um aparelho
                    pode criar cofres independentes.
                  </small>
                </span>
              </label>
              <label className="sync-choice sync-reset-choice">
                <input
                  type="radio"
                  name="server-reset-intent"
                  value="join-existing"
                  aria-label="Conectar este aparelho a um cofre já recriado"
                  aria-describedby="server-reset-join-description"
                  checked={resetIntent === 'join-existing'}
                  onChange={() => {
                    setResetIntent('join-existing');
                    setResetConfirmed(false);
                  }}
                />
                <span>
                  <strong>Conectar este aparelho a um cofre já recriado</strong>
                  <small id="server-reset-join-description">
                    Outro aparelho já criou o novo cofre. Depois do backup e da
                    desvinculação, use o convite LPV2 desse aparelho e aguarde sua
                    aprovação. Este fluxo não cria um novo cofre.
                  </small>
                </span>
              </label>
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
              checked={resetConfirmed}
              disabled={busy || !resetIntent}
              onChange={(e) => setResetConfirmed(e.target.checked)}
            />
            <span>
              Entendo que o remoto anterior será abandonado e que o backup será
              preservado antes de remover o vínculo.
            </span>
          </label>
          <div className="sync-actions sync-actions--end sync-reset-footer">
            <button
              className="button button--primary"
              disabled={busy || !resetIntent || !resetConfirmed || !endpoint.trim()}
              onClick={() =>
                void run('server-reset', [endpoint, resetIntent, resetConfirmed])
              }
            >
              Preservar backup e remover vínculo antigo
            </button>
          </div>
        </SyncSection>
      )}
      {resetReady && (
        <SyncSection icon={HardDrive} title="Banco local preservado">
          <p>Backup criado: {status.serverReset!.backupPath}</p>
          {status.serverReset!.intent === 'source-of-truth' && (
            <>
              <p>
                Este aparelho foi escolhido como fonte de verdade. Crie o novo
                cofre usando seus dados locais.
              </p>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void run('create')}
              >
                Criar novo cofre usando estes dados
              </button>
            </>
          )}
          {joiningRecreated && (
            <>
              <p>
                Use o convite do aparelho que já recriou o cofre. Abra o link LPV2
                neste computador ou cole o convite abaixo. Este aparelho pedirá
                acesso e aguardará aprovação.
              </p>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => {
                  invitationInput.current?.focus();
                  invitationInput.current?.scrollIntoView({ block: 'center' });
                }}
              >
                Conectar por convite
              </button>
            </>
          )}
        </SyncSection>
      )}
      {status.phase === 'local' && status.pairingStep === 'preparing' && (
        <p role="status">Preparando conexão…</p>
      )}
      {status.phase === 'local' && !resetReady && !setup && (
        <div className="sync-onboarding">
          <div className="sync-onboarding__content">
            <span className="eyebrow">Conecte quando quiser</span>
            <h4>Seu planejamento acompanha você.</h4>
            <p>
              Conecte seu computador e celular a um servidor da sua escolha. Se
              ele ficar indisponível, o LionPocket continua funcionando.
            </p>
            <button
              className="button button--primary"
              onClick={() => setSetup(true)}
            >
              <Plus size={16} aria-hidden="true" />
              Configurar sincronização
            </button>
          </div>
          <ul className="sync-benefits">
            <li>
              <HardDrive size={18} aria-hidden="true" />
              <div>
                <strong>Salvo primeiro aqui</strong>
                <span>Seu banco continua neste aparelho.</span>
              </div>
            </li>
            <li>
              <LockKeyhole size={18} aria-hidden="true" />
              <div>
                <strong>Conteúdo criptografado</strong>
                <span>Os dados são cifrados antes do envio.</span>
              </div>
            </li>
            <li>
              <Server size={18} aria-hidden="true" />
              <div>
                <strong>Você escolhe o servidor</strong>
                <span>Configure apenas quando precisar.</span>
              </div>
            </li>
          </ul>
        </div>
      )}

      {status.phase === 'local' && (
        <>
          {setup && !resetReady && (
            <SyncSection
              icon={Server}
              title="Configurar sincronização"
              description="Conecte seu servidor e crie seu cofre."
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && endpoint.trim()) void run('setup', [endpoint]);
                }}
              >
                <label className="field">
                  <span>Servidor próprio</span>
                  <input
                    aria-label="Servidor próprio"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    placeholder="https://sync.exemplo.com"
                  />
                </label>
                <button
                  className="button button--primary"
                  disabled={busy || !endpoint.trim()}
                >
                  Conectar
                </button>
              </form>
            </SyncSection>
          )}
          <SyncSection
            icon={Link2}
            title={joiningRecreated ? 'Conectar ao cofre já recriado' : 'Colar convite'}
            description="Se o link não abrir o aplicativo, cole o convite do aparelho conectado."
          >
            <label className="field">
              <span>Convite do cofre</span>
              <textarea
                aria-label="Convite do cofre"
                ref={invitationInput}
                value={invitation}
                onChange={(e) => setInvitation(e.target.value)}
              />
            </label>
            {inviteInfo && (
              <>
                <p>Cofre pessoal · {new URL(inviteInfo.endpoint).host}</p>
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void run('pairing-connect', [invitation])}
                >
                  Conectar
                </button>
              </>
            )}
          </SyncSection>
          <SyncDisclosure icon={KeyRound} title="Recuperar um cofre existente">
            <p>Use o pacote de recuperação e o código guardados fora do aplicativo.</p>
            <label className="field"><span>Pacote de recuperação</span>
              <textarea aria-label="Pacote de recuperação" value={recoveryPackage} onChange={e => setRecoveryPackage(e.target.value)} />
            </label>
            <label className="field"><span>Código de recuperação</span>
              <input aria-label="Código de recuperação" type="password" value={confirmedCode} onChange={e => setConfirmedCode(e.target.value)} />
            </label>
            <button className="button" disabled={busy || !recoveryPackage || !confirmedCode} onClick={() => void run('recover',[recoveryPackage,confirmedCode])}>Recuperar cofre</button>
          </SyncDisclosure>
        </>
      )}
      {status.phase === 'creating' && (
        <SyncSection
          icon={RefreshCw}
          title="Continue a configuração"
          description="A criação do cofre ainda não foi concluída. Retome de onde parou."
        >
          <div className="sync-actions">
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => void run('create')}
            >
              Retomar criação do cofre
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </SyncSection>
      )}
      {status.phase === 'pairing' && (
        <SyncSection
          icon={Smartphone}
          title={
            status.pairingStep === 'preparing'
              ? 'Preparando conexão…'
              : status.pairingStep === 'connecting'
                ? 'Conectando…'
                : 'Aguardando aprovação no outro aparelho'
          }
          description="Confira o mesmo código no aparelho conectado antes de aprovar."
        >
          <div className="sync-fingerprint">
            <span>Código de segurança</span>
            <code>{status.pairingCode}</code>
          </div>
          {status.pairingError &&
            /^(Convite|Pedido recusado|Este convite)/.test(
              status.pairingError,
            ) && (
              <label className="field">
                <span>Cole um novo convite do aparelho conectado</span>
                <textarea
                  aria-label="Novo convite do cofre"
                  value={invitation}
                  onChange={(e) => setInvitation(e.target.value)}
                />
              </label>
            )}
          {inviteInfo && inviteInfo.id !== status.pairingInviteId && (
            <>
              <p>Cofre pessoal · {new URL(inviteInfo.endpoint).host}</p>
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void run('pairing-connect', [invitation])}
              >
                Conectar
              </button>
            </>
          )}
          {status.pairingError && <p role="alert">{status.pairingError}</p>}
        </SyncSection>
      )}
      {status.phase === 'bound' && (
        <p role="status">
          {status.lastCompletedAt
            ? 'Sincronização pronta'
            : 'Sincronizando dados…'}
        </p>
      )}
      {canManage && (
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

          <div className="sync-management">
            {status.owner && (
              <SyncSection icon={Smartphone} title="Aparelhos">
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void run('invite-create')}
                >
                  Adicionar aparelho
                </button>
                {adding && status.pairingRequests.length === 0 && (
                  <>
                    <p>
                      Escaneie com outro celular ou abra o link no computador. Convite válido por 15 minutos
                      e para um aparelho.
                    </p>
                    {pairingLink && <PairingQR link={pairingLink} />}
                    <div className="sync-actions">
                      <button
                        className="button"
                        onClick={() =>
                          void navigator.clipboard.writeText(pairingLink)
                        }
                      >
                        Copiar link
                      </button>
                      <button
                        className="button"
                        onClick={() => {
                          if (navigator.share)
                            void navigator.share({ text: pairingLink });
                          else void navigator.clipboard.writeText(pairingLink);
                        }}
                      >
                        Compartilhar convite
                      </button>
                      <button
                        className="button"
                        onClick={() => void navigator.clipboard.writeText(pairingLink)}
                      >Copiar convite</button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void run('invite-revoke')}
                      >
                        Cancelar convite
                      </button>
                    </div>
                  </>
                )}
                {status.pairingRequests.map((r) => (
                  <div className="sync-request" key={r.deviceId}>
                    <strong>Novo aparelho · {r.deviceName}</strong>
                    <p>Solicitando acesso agora</p>
                    <div className="sync-fingerprint">
                      <span>Código de segurança</span>
                      <code>{r.securityCode}</code>
                      <small>Confira o mesmo código no novo aparelho.</small>
                    </div>
                    <div className="sync-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void run('pairing-deny', [r.deviceId])}
                      >
                        Recusar
                      </button>
                      <button
                        className="button button--primary"
                        disabled={busy}
                        onClick={() => void run('approve', [r.deviceId])}
                      >
                        Aprovar aparelho
                      </button>
                    </div>
                  </div>
                ))}
              </SyncSection>
            )}
            {status.owner && status.recoveryVersion === '0' && (
              <p role="alert">
                Proteja seu cofre: guarde um código de recuperação na seção
                Recuperação e proteção.
              </p>
            )}

            {status.owner && (
              <SyncDisclosure
                icon={KeyRound}
                title="Recuperação e proteção"
                description="Guarde o acesso ao cofre e gerencie as chaves dos seus aparelhos."
              >
                <div className="sync-protection-status">
                  <span>
                    <ShieldCheck size={15} aria-hidden="true" />
                    Recuperação{' '}
                    {status.recoveryVersion !== '0'
                      ? 'confirmada'
                      : 'não confirmada'}
                  </span>
                  <span>Versão da chave: {status.activeKeyVersion}</span>
                </div>
                {!!status.recoveryPackage && <label className="field"><span>Pacote atual de recuperação · guarde junto do código</span>
                  <textarea readOnly aria-label="Pacote atual de recuperação" value={status.recoveryPackage} />
                  <small>Atualize a cópia guardada após recuperar o servidor.</small>
                </label>}
                <div className="sync-subsection">
                  <div className="sync-setting-row">
                    <div>
                      <h5>Código de recuperação</h5>
                      <p>
                        Guarde este segredo fora do aplicativo. Ele recupera o
                        conteúdo e o acesso ao cofre.
                      </p>
                    </div>
                    {!recoveryCode && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void run('recovery-generate')}
                      >
                        <KeyRound size={16} aria-hidden="true" />
                        Gerar código de recuperação
                      </button>
                    )}
                  </div>
                  {recoveryCode && (
                    <RecoveryCode
                      code={recoveryCode}
                      confirmed={confirmedCode}
                      onConfirmChange={setConfirmedCode}
                      busy={busy}
                      confirmLabel="Confirmar código de recuperação"
                      onConfirm={() =>
                        void run('recovery-confirm', [confirmedCode])
                      }
                      recoveryDetails={{
                        endpoint: status.endpoint,
                        recoveryPackage: status.recoveryPackage,
                      }}
                      onRegenerate={() => void run('recovery-generate')}
                    />
                  )}
                </div>
                <SyncDisclosure
                  icon={ShieldCheck}
                  title="Gerenciar chaves e acesso"
                  description="Opções avançadas de proteção do cofre."
                >
                  <div className="sync-subsection">
                    <h5>Atualizar a chave de criptografia</h5>
                    <p>
                      Gere uma nova versão da chave e retome uma operação
                      pendente.
                    </p>
                    <div className="sync-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => void run('rotate')}
                      >
                        Rotacionar chave
                      </button>
                    </div>
                  </div>
                  <div className="sync-subsection sync-subsection--danger">
                    <h5>Remover o acesso de um aparelho</h5>
                    <p>
                      O aparelho será revogado e a chave do cofre será
                      atualizada. Confira o identificador em Dispositivos e
                      diagnóstico.
                    </p>
                    <label className="field">
                      <span>ID do aparelho a revogar</span>
                      <input
                        value={revokeId}
                        onChange={(e) => setRevokeId(e.target.value)}
                      />
                    </label>
                    <div className="sync-actions">
                      <button
                        className="button button--danger"
                        disabled={busy || !revokeId}
                        onClick={() => void run('revoke', [revokeId, revokeId])}
                      >
                        Revogar aparelho e rotacionar chave
                      </button>
                    </div>
                  </div>
                </SyncDisclosure>
              </SyncDisclosure>
            )}

            <SyncDisclosure
              icon={Server}
              title="Dispositivos e diagnóstico"
              description="Consulte os aparelhos vinculados e os detalhes da sincronização."
            >
              <ul className="sync-device-list">
                {status.devices.map((d) => (
                  <li key={d.registryVersion}>
                    <Smartphone size={17} aria-hidden="true" />
                    <span className="sync-identifier">{d.deviceId}</span>
                    <span className="sync-device-status">
                      {d.status === 'approved'
                        ? 'Aprovado'
                        : d.status === 'revoked'
                          ? 'Revogado'
                          : d.status}
                    </span>
                  </li>
                ))}
              </ul>
              {!status.devices.length && (
                <p>Nenhum aparelho listado neste momento.</p>
              )}
              {!!(status.reviews.length || status.quarantine.length) && (
                <div className="sync-subsection">
                  <h5>Diagnóstico das revisões</h5>
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
                </div>
              )}
            </SyncDisclosure>
          </div>

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
                  return (
                    <div className="sync-conflict" key={b.revisionId}>
                      <h5>{summary.title}</h5>
                      {summary.lines.map((line, index) => (
                        <p key={index}>{line}</p>
                      ))}
                      <small>
                        Alterado em{' '}
                        {new Date(b.revision.authoredAt).toLocaleString(
                          'pt-BR',
                        )}
                      </small>
                      <details className="sync-technical">
                        <summary>Detalhes desta versão</summary>
                        <pre>{JSON.stringify(b.revision, null, 2)}</pre>
                      </details>
                      <button
                        className="button button--soft"
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
                  A cópia restaurada não contém este registro. Confirme a
                  exclusão somente se você deseja removê-lo também dos outros
                  aparelhos.
                </p>
                <details className="sync-technical">
                  <summary>Identificador do registro</summary>
                  <code>{String(r.object_id)}</code>
                </details>
                <div className="sync-actions">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run('delete-review', [r.object_id, true])
                    }
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
      )}
      <footer className="sync-panel__footnote">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>
          O LionPocket salva primeiro neste aparelho. A sincronização envia
          conteúdo criptografado enquanto o aplicativo está aberto.
        </span>
      </footer>
    </section>
  );
}

function SyncSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="sync-section">
      <header className="sync-section__header">
        <Icon size={18} aria-hidden="true" />
        <div>
          <h4>{title}</h4>
          {description && <p>{description}</p>}
        </div>
      </header>
      <div className="sync-section__body">{children}</div>
    </section>
  );
}

function SyncDisclosure({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <details className="sync-disclosure">
      <summary>
        <Icon size={18} aria-hidden="true" />
        <span>
          <strong>{title}</strong>
          {description && <small>{description}</small>}
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="sync-disclosure__chevron"
        />
      </summary>
      <div className="sync-disclosure__body">{children}</div>
    </details>
  );
}

function SyncNotice({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'error' | 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`sync-notice sync-notice--${tone}`} role="alert">
      <CircleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

function RecoveryCode({
  code,
  confirmed,
  onConfirmChange,
  busy,
  confirmLabel,
  onConfirm,
  recoveryDetails,
  onRegenerate,
}: {
  code: string;
  confirmed: string;
  onConfirmChange: (value: string) => void;
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  recoveryDetails?: { endpoint: string; recoveryPackage: string };
  onRegenerate?: () => void;
}) {
  return (
    <div className="sync-recovery-code">
      <div className="sync-recovery-code__steps">
        <section className="sync-recovery-step">
          <header className="sync-recovery-step__header">
            <span aria-hidden="true">1</span>
            <div>
              <h5>Guarde seu código</h5>
              <p>Salve fora do aplicativo, em um lugar seguro.</p>
            </div>
          </header>
          <div className="sync-fingerprint">
            <code>{code}</code>
          </div>
          {recoveryDetails && (
            <details className="sync-recovery-kit">
              <summary>
                <Link2 size={14} aria-hidden="true" />
                Pacote de recuperação para guardar
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <label className="field">
                <span>
                  Guarde o pacote e o código de recuperação juntos
                </span>
                <textarea
                  readOnly
                  aria-label="Informações para recuperar seus dados"
                  value={`Servidor: ${recoveryDetails.endpoint}\nCódigo de recuperação: ${code}\nPacote de recuperação: ${recoveryDetails.recoveryPackage}`}
                />
              </label>
            </details>
          )}
        </section>
        <section className="sync-recovery-step">
          <header className="sync-recovery-step__header">
            <span aria-hidden="true">2</span>
            <div>
              <h5>Confirme o que guardou</h5>
              <p>Digite o código para concluir esta etapa.</p>
            </div>
          </header>
          <label className="field">
            <span>Digite o código que você guardou</span>
            <input
              aria-label="Digite o código que você guardou"
              type="password"
              autoComplete="off"
              value={confirmed}
              onChange={(e) => onConfirmChange(e.target.value)}
            />
          </label>
        </section>
      </div>
      <div className="sync-recovery-code__footer">
        {onRegenerate ? (
          <button
            className="button button--ghost"
            disabled={busy}
            onClick={onRegenerate}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Gerar outro código
          </button>
        ) : (
          <span className="sync-recovery-code__hint">
            <LockKeyhole size={14} aria-hidden="true" />A confirmação exige o
            código completo.
          </span>
        )}
        <button
          className="button button--primary"
          disabled={busy || confirmed !== code}
          onClick={onConfirm}
        >
          <ShieldCheck size={16} aria-hidden="true" />
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function PairingQR({ link }: { link: string }) {
  const matrix = pairingQr(link);
  return (
    <svg
      role="img"
      aria-label="QR Code para conectar outro aparelho"
      width="320"
      height="320"
      viewBox={`0 0 ${matrix.length} ${matrix.length}`}
      style={{ maxWidth: '100%', background: '#fff' }}
      shapeRendering="crispEdges"
    >
      <path
        d={matrix
          .flatMap((row, y) =>
            row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')),
          )
          .join('')}
        fill="#000"
      />
    </svg>
  );
}
