import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { RecoveryCode, SyncDisclosure } from './primitives';
import type { SyncSession } from './useSyncSession';

/** Recovery code and key management for the vault owner. */
export function ProtectionSection({ status, busy, run }: SyncSession) {
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const [revokeId, setRevokeId] = useState('');
  const generate = () =>
    void run('recovery-generate', [], (result) =>
      setRecoveryCode((result as { code: string }).code),
    );
  return (
    <>
      {status.recoveryVersion === '0' && (
        <p role="alert" className="sync-protection-alert">
          Proteja seu cofre: guarde um código de recuperação na seção
          Recuperação e proteção.
        </p>
      )}
      <SyncDisclosure
        icon={KeyRound}
        title="Recuperação e proteção"
        description="Guarde o acesso ao cofre e gerencie as chaves dos seus aparelhos."
      >
        <div className="sync-protection-status">
          <span>
            <ShieldCheck size={15} aria-hidden="true" />
            Recuperação{' '}
            {status.recoveryVersion !== '0' ? 'confirmada' : 'não confirmada'}
          </span>
          <span>Versão da chave: {status.activeKeyVersion}</span>
        </div>
        {!!status.recoveryPackage && (
          <label className="field">
            <span>Pacote atual de recuperação · guarde junto do código</span>
            <textarea
              readOnly
              aria-label="Pacote atual de recuperação"
              value={status.recoveryPackage}
            />
            <small>Atualize a cópia guardada após recuperar o servidor.</small>
          </label>
        )}
        <div className="sync-subsection">
          <div className="sync-setting-row">
            <div>
              <h5>Código de recuperação</h5>
              <p>
                Guarde este segredo fora do aplicativo. Ele recupera o conteúdo
                e o acesso ao cofre.
              </p>
            </div>
            {!recoveryCode && (
              <button className="button" disabled={busy} onClick={generate}>
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
                void run('recovery-confirm', [confirmedCode], () => {
                  setRecoveryCode('');
                  setConfirmedCode('');
                })
              }
              recoveryDetails={{
                endpoint: status.endpoint,
                recoveryPackage: status.recoveryPackage,
              }}
              onRegenerate={generate}
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
            <p>Gere uma nova versão da chave e retome uma operação pendente.</p>
            <div className="sync-actions">
              <button className="button" disabled={busy} onClick={() => void run('rotate')}>
                Rotacionar chave
              </button>
            </div>
          </div>
          <div className="sync-subsection sync-subsection--danger">
            <h5>Remover o acesso de um aparelho</h5>
            <p>
              O aparelho será revogado e a chave do cofre será atualizada.
              Confira o identificador na lista de Aparelhos.
            </p>
            <label className="field">
              <span>ID do aparelho a revogar</span>
              <input value={revokeId} onChange={(e) => setRevokeId(e.target.value)} />
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
    </>
  );
}
