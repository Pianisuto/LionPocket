import { serverRecoveryStep, serverRecoveryTitle } from '@lionpocket/sync-local';
import { useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { RecoveryCode, SyncSection } from './primitives';
import type { SyncSession } from './useSyncSession';

/** Rebuilds the server history from this device after a server restore. */
export function ServerRecovery({ status, busy, run }: SyncSession) {
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const step = serverRecoveryStep(status.recoveryPhase);
  const prepare = () =>
    void run('server-recovery-prepare', [true], (result) => {
      const code = (result as { code?: string }).code;
      if (code) setRecoveryCode(code);
    });
  return (
    <SyncSection
      icon={ShieldCheck}
      title={serverRecoveryTitle(status.recoveryPhase)}
      description={
        step === 'recovered'
          ? 'Este aparelho está pronto para sincronizar novamente.'
          : 'Seus dados locais estão preservados. Mantenha este aparelho aberto durante a recuperação.'
      }
    >
      {step === 'start' && (
        <div className="sync-actions">
          <button className="button button--primary" disabled={busy} onClick={prepare}>
            Preparar recuperação
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {(step === 'preparing' || step === 'other') && (
        <div className="sync-actions">
          <button className="button" disabled={busy} onClick={prepare}>
            Continuar preparação
          </button>
        </div>
      )}
      {status.recoveryPhase === 'recovery_pending_confirmation' && recoveryCode && (
        <RecoveryCode
          code={recoveryCode}
          confirmed={confirmedCode}
          onConfirmChange={setConfirmedCode}
          busy={busy}
          confirmLabel="Guardei e conferi o código"
          onConfirm={() =>
            void run('server-recovery-confirm', [confirmedCode], () => {
              setRecoveryCode('');
              setConfirmedCode('');
            })
          }
        />
      )}
      {step === 'prepared' && (
        <>
          <p>
            O servidor passará a usar os dados reconstruídos deste aparelho como
            a nova base de sincronização.
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
      {step === 'finalizing' && (
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
  );
}
