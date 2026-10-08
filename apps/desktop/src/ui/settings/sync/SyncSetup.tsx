import {
  vaultConnectionCopy,
  type ServerResetIntent,
} from '@lionpocket/sync-local';
import { useState, type RefObject } from 'react';
import {
  ArrowRight,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Server,
} from 'lucide-react';
import { SyncDisclosure, SyncSection } from './primitives';
import { InvitationSection } from './Pairing';
import { useEndpointDraft, type SyncSession } from './useSyncSession';

/** First configuration: explains the choice and connects to a server. */
export function SyncSetup({
  status,
  busy,
  run,
  setError,
  inputRef,
}: SyncSession & {
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<ServerResetIntent>();
  const [endpoint, setEndpoint] = useEndpointDraft(status.endpoint);
  if (open)
    return (
      <>
        <SyncSection
          icon={Server}
          title="Configurar sincronização"
          description="Crie um cofre no primeiro aparelho ou use o convite de um aparelho conectado."
        >
          <fieldset className="sync-reset-choices" disabled={busy}>
            <legend>{vaultConnectionCopy.question}</legend>
            <div className="sync-reset-choices__grid">
              {vaultConnectionCopy.choices.map((choice) => (
                <label
                  key={choice.intent}
                  className="sync-choice sync-reset-choice"
                >
                  <input
                    type="radio"
                    name="vault-connection-intent"
                    value={choice.intent}
                    aria-label={choice.label}
                    aria-describedby={`vault-${choice.intent}-description`}
                    checked={intent === choice.intent}
                    onChange={() => setIntent(choice.intent)}
                  />
                  <span>
                    <strong>{choice.label}</strong>
                    <small id={`vault-${choice.intent}-description`}>
                      {choice.description}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p>{vaultConnectionCopy.backup}</p>
          {intent === 'source-of-truth' && (
            <form
              className="sync-server-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && intent === 'source-of-truth' && endpoint.trim())
                  void run('setup', [endpoint]);
              }}
            >
              <label className="field">
                <span>Servidor próprio</span>
                <input
                  aria-label="Servidor próprio"
                  value={endpoint}
                  disabled={busy}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://sync.exemplo.com"
                />
              </label>
              <button
                className="button button--primary"
                disabled={busy || !endpoint.trim()}
              >
                {vaultConnectionCopy.createAction}
              </button>
            </form>
          )}
        </SyncSection>
        {intent === 'join-existing' && (
          <InvitationSection
            status={status}
            busy={busy}
            run={run}
            setError={setError}
            inputRef={inputRef}
            title="Entrar em um cofre existente por convite"
          />
        )}
      </>
    );
  return (
    <div className="sync-onboarding">
      <div className="sync-onboarding__content">
        <span className="eyebrow">Conecte quando quiser</span>
        <h4>Seu planejamento acompanha você.</h4>
        <p>
          Conecte seu computador e celular a um servidor da sua escolha. Se ele
          ficar indisponível, o LionPocket continua funcionando.
        </p>
        <button
          className="button button--primary"
          onClick={() => setOpen(true)}
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
  );
}

/** Restores access to a vault with the package and code kept outside the app. */
export function RecoverVault({ busy, run }: SyncSession) {
  const [recoveryPackage, setRecoveryPackage] = useState('');
  const [code, setCode] = useState('');
  return (
    <SyncDisclosure icon={KeyRound} title="Recuperar um cofre existente">
      <p>
        Use o pacote de recuperação e o código guardados fora do aplicativo.
      </p>
      <label className="field">
        <span>Pacote de recuperação</span>
        <textarea
          aria-label="Pacote de recuperação"
          value={recoveryPackage}
          onChange={(e) => setRecoveryPackage(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Código de recuperação</span>
        <input
          aria-label="Código de recuperação"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <div className="sync-actions">
        <button
          className="button"
          disabled={busy || !recoveryPackage || !code}
          onClick={() => void run('recover', [recoveryPackage, code])}
        >
          Recuperar cofre
        </button>
      </div>
    </SyncDisclosure>
  );
}

/** An interrupted vault creation resumes from the saved step. */
export function ResumeVaultCreation({ busy, run }: SyncSession) {
  return (
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
  );
}
