import { syncActivityLabel, revisionSummary } from '@lionpocket/sync-local';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
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
import type {
  SyncStatus,
} from '@lionpocket/sync-local';
import type { PairingRequest } from '@lionpocket/sync-protocol';

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
  const [fingerprint, setFingerprint] = useState('');
  const [authority, setAuthority] = useState('');
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const [setup, setSetup] = useState(false);
  const [path, setPath] = useState<'create' | 'pair' | ''>('');

  const refresh = async () => {
    const s = await window.lionPocket.syncStatus?.();
    if (s) {
      setStatus(s);
      setEndpoint(s.endpoint);

    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
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
      if (action === 'inspect')
        setAuthority((result as { fingerprint: string }).fingerprint);
      if (action === 'requests')
        setRequests((result as { requests: PairingRequest[] }).requests);
      await refresh();
      await onChanged();
    } catch (e) {
      setError(String(e));
      await refresh().catch(() => {
        /* Preserve the operation error. */
      });
    } finally {
      setBusy(false);
    }
  };
  const choosePath = (next: 'create' | 'pair') => {
    setPath(next);
    setReviewed(false);
  };
  const configured = !!status?.discovered && endpoint === status.endpoint;
  if (!status) return error ? <p role="alert">{error}</p> : null;

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

      {status.phase === 'local' && !setup && (
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

      {status.phase === 'local' && setup && (
        <div className="sync-setup">
          <ol className="sync-steps" aria-label="Etapas da configuração">
            {['Servidor', 'Como conectar', 'Confirmar'].map((label, index) => {
              const current = !configured ? 0 : !path ? 1 : 2;
              return (
                <li
                  key={label}
                  className={
                    index === current
                      ? 'is-current'
                      : index < current
                        ? 'is-done'
                        : ''
                  }
                  aria-current={index === current ? 'step' : undefined}
                >
                  <span>
                    {index < current ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {label}
                </li>
              );
            })}
          </ol>
          <SyncSection
            icon={Server}
            title="Escolha seu servidor"
            description="Informe a URL HTTPS fornecida por quem administra o servidor."
          >
            <form
              className="sync-server-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && endpoint.trim()) void run('configure', [endpoint]);
              }}
            >
              <label className="field">
                <span>Servidor próprio</span>
                <input
                  aria-label="Servidor próprio"
                  placeholder="https://sync.exemplo.com"
                  autoComplete="url"
                  value={endpoint}
                  disabled={busy}
                  onChange={(e) => {
                    setEndpoint(e.target.value);
                    setPath('');
                    setReviewed(false);
                    setAuthority('');
                  }}
                />
              </label>
              <button
                className={`button ${configured ? '' : 'button--primary'}`}
                disabled={busy || !endpoint.trim()}
              >
                {configured ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <ArrowRight size={16} aria-hidden="true" />
                )}
                {configured ? 'Verificar novamente' : 'Verificar servidor'}
              </button>
            </form>
            {configured && (
              <div className="sync-server-verified">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>
                  Servidor verificado. Você fará login em{' '}
                  <strong>
                    {new URL(status.discovered!.oidc.issuer).host}
                  </strong>
                  .
                </span>
              </div>
            )}
          </SyncSection>
          {configured && (
            <>
              <div
                className="sync-choice-grid"
                aria-label="Como conectar este aparelho"
              >
                <button
                  className={`sync-choice ${path === 'create' ? 'is-selected' : ''}`}
                  aria-pressed={path === 'create'}
                  disabled={busy}
                  onClick={() => choosePath('create')}
                >
                  <span className="settings-icon">
                    <Plus size={20} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Criar minha sincronização</strong>
                    <small>
                      Comece por este aparelho e conecte os outros depois.
                    </small>
                  </span>
                  <span className="sync-choice__indicator">
                    {path === 'create' && (
                      <Check size={13} aria-hidden="true" />
                    )}
                  </span>
                </button>
                <button
                  className={`sync-choice ${path === 'pair' ? 'is-selected' : ''}`}
                  aria-pressed={path === 'pair'}
                  disabled={busy}
                  onClick={() => choosePath('pair')}
                >
                  <span className="settings-icon">
                    <Link2 size={20} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>Tenho um convite</strong>
                    <small>
                      Conecte este aparelho a uma sincronização existente.
                    </small>
                  </span>
                  <span className="sync-choice__indicator">
                    {path === 'pair' && <Check size={13} aria-hidden="true" />}
                  </span>
                </button>
              </div>
              {path && (
                <SyncSection
                  icon={path === 'pair' ? Link2 : ShieldCheck}
                  title={
                    path === 'pair'
                      ? 'Conecte com seu convite'
                      : 'Comece com os dados deste aparelho'
                  }
                  description="Uma cópia de segurança local será criada antes de vincular esta base."
                >
                  {path === 'pair' && (
                    <>
                      <label className="field">
                        <span>Convite do outro aparelho</span>
                        <textarea
                          aria-label="Convite do cofre"
                          placeholder="Cole aqui o convite gerado no outro aparelho"
                          value={invitation}
                          onChange={(e) => {
                            setInvitation(e.target.value);
                            setAuthority('');
                            setFingerprint('');
                          }}
                        />
                      </label>
                      <div className="sync-actions">
                        <button
                          className="button"
                          disabled={busy || !invitation}
                          onClick={() => void run('inspect', [invitation])}
                        >
                          <ShieldCheck size={16} aria-hidden="true" />
                          Conferir convite
                        </button>
                      </div>
                      {authority && (
                        <div className="sync-field-grid">
                          <div className="sync-fingerprint">
                            <span>Código de segurança do cofre</span>
                            <code>{authority}</code>
                            <small>
                              Compare com o código exibido no aparelho que criou
                              o cofre.
                            </small>
                          </div>
                          <label className="field">
                            <span>Código conferido no outro aparelho</span>
                            <input
                              aria-label="Código de segurança do cofre conferido"
                              autoComplete="off"
                              value={fingerprint}
                              onChange={(e) => setFingerprint(e.target.value)}
                            />
                          </label>
                        </div>
                      )}
                    </>
                  )}
                  <div className="sync-section__footer">
                    <span>
                      <LockKeyhole size={14} aria-hidden="true" />
                      Seus dados são criptografados aqui antes do envio.
                    </span>
                    {path === 'create' ? (
                      <button
                        className="button button--primary"
                        disabled={busy}
                        onClick={() => void run('create')}
                      >
                        Entrar e criar cofre
                        <ArrowRight size={16} aria-hidden="true" />
                      </button>
                    ) : (
                      authority && (
                        <button
                          className="button button--primary"
                          disabled={
                            busy || fingerprint !== authority
                          }
                          onClick={() =>
                            void run('pair', [invitation, fingerprint])
                          }
                        >
                          Entrar e pedir aprovação
                          <ArrowRight size={16} aria-hidden="true" />
                        </button>
                      )
                    )}
                  </div>
                </SyncSection>
              )}
            </>
          )}
          {authority && (
            <SyncDisclosure
              icon={KeyRound}
              title="Recuperar em uma nova instalação"
              description="Use seu código de recuperação se você perdeu o acesso aos outros aparelhos."
            >
              <label className="field">
                <span>Código de recuperação</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={confirmedCode}
                  onChange={(e) => setConfirmedCode(e.target.value)}
                />
              </label>
              <div className="sync-actions">
                <button
                  className="button"
                  disabled={busy || fingerprint !== authority || !confirmedCode}
                  onClick={() =>
                    void run('recover', [
                      invitation,
                      fingerprint,
                      confirmedCode,
                    ])
                  }
                >
                  Entrar e recuperar cofre
                </button>
              </div>
            </SyncDisclosure>
          )}
          <div className="sync-actions">
            <button
              className="button button--ghost"
              disabled={busy}
              onClick={() => {
                setSetup(false);
                setPath('');
                setReviewed(false);
              }}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Voltar
            </button>
          </div>
        </div>
      )}

      {status.phase === 'recovery' && (
        <SyncSection
          icon={KeyRound}
          title="Guarde seu código de recuperação"
          description="Ele permite recuperar os dados criptografados se você perder todos os aparelhos. Guarde o código e o convite juntos, em um lugar seguro fora do aplicativo."
        >
          {!recoveryCode ? (
            <div className="sync-actions sync-actions--end">
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void run('recovery-generate')}
              >
                <KeyRound size={16} aria-hidden="true" />
                Mostrar código de recuperação
              </button>
            </div>
          ) : (
            <RecoveryCode
              code={recoveryCode}
              confirmed={confirmedCode}
              onConfirmChange={setConfirmedCode}
              busy={busy}
              confirmLabel="Ativar sincronização"
              onConfirm={() => void run('recovery-confirm', [confirmedCode])}
              recoveryDetails={{
                endpoint: status.endpoint,
                invitation: status.invitation,
              }}
              onRegenerate={() => void run('recovery-generate')}
            />
          )}
          {!recoveryCode && (
            <SyncDisclosure icon={Link2} title="Convite para recuperação">
              <label className="field">
                <span>Guarde junto do código de recuperação</span>
                <textarea
                  readOnly
                  aria-label="Convite para recuperação"
                  value={status.invitation}
                />
              </label>
            </SyncDisclosure>
          )}
        </SyncSection>
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
          title="Aprove este aparelho para continuar"
          description="Abra o LionPocket em um aparelho já conectado e confira o código abaixo antes de aprovar o pedido."
        >
          <div className="sync-fingerprint">
            <span>Código deste aparelho</span>
            <code>{status.pairingFingerprint}</code>
          </div>
          <div className="sync-section__footer">
            <span>A chave será recebida depois da aprovação.</span>
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => void run('receive')}
            >
              Entrar e receber chave
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </SyncSection>
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
              <SyncDisclosure
                icon={Smartphone}
                title="Adicionar dispositivo"
                description="Conecte outro computador ou celular com um convite e sua aprovação."
              >
                <label className="field">
                  <span>Convite público</span>
                  <textarea
                    aria-label="Convite para outro aparelho"
                    readOnly
                    value={status.invitation}
                  />
                </label>
                <div className="sync-fingerprint">
                  <span>Código de segurança do cofre</span>
                  <code>{status.authorityFingerprint}</code>
                  <small>
                    Confira este código no outro aparelho antes de enviar o
                    pedido.
                  </small>
                </div>
                <div className="sync-actions">
                  <button
                    className="button button--soft"
                    disabled={busy}
                    onClick={() => void run('requests')}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    Entrar e buscar pedidos
                  </button>
                </div>
                {requests.map((r) => (
                  <div className="sync-request" key={r.deviceId}>
                    <div>
                      <strong>Pedido de conexão</strong>
                      <p>
                        Aparelho:{' '}
                        <span className="sync-identifier">{r.deviceId}</span>
                      </p>
                    </div>
                    <div className="sync-field-grid">
                      <div className="sync-fingerprint">
                        <span>Código do pedido</span>
                        <code>{r.fingerprint}</code>
                      </div>
                      <label className="field">
                        <span>Código exibido no aparelho</span>
                        <input
                          aria-label={`Código do aparelho ${r.deviceId}`}
                          autoComplete="off"
                          value={fingerprint}
                          onChange={(e) => setFingerprint(e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="sync-actions">
                      <button
                        className="button button--primary"
                        disabled={busy || fingerprint !== r.fingerprint}
                        onClick={() =>
                          void run('approve', [r.deviceId, fingerprint])
                        }
                      >
                        Aprovar e entregar chave
                        <Check size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </SyncDisclosure>
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
                        invitation: status.invitation,
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
                  A cópia restaurada não contém este registro. Confirme a exclusão somente se você deseja removê-lo também dos outros aparelhos.
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
                      void run(
                        'delete-review',
                        [r.object_id, true],
                      )
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
  recoveryDetails?: { endpoint: string; invitation: string };
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
                Convite e informações para guardar
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <label className="field">
                <span>
                  Guarde o código, o convite e o endereço do servidor juntos
                </span>
                <textarea
                  readOnly
                  aria-label="Informações para recuperar seus dados"
                  value={`Servidor: ${recoveryDetails.endpoint}\nCódigo de recuperação: ${code}\nConvite: ${recoveryDetails.invitation}`}
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
