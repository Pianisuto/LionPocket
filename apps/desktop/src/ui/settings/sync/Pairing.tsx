import { canReplaceInvitation, pairingStepTitle } from '@lionpocket/sync-local';
import { useState } from 'react';
import type { RefObject } from 'react';
import { Link2, Smartphone } from 'lucide-react';
import { SyncSection } from './primitives';
import { useInvitationPreview, type SyncSession } from './useSyncSession';

/** Joining side: paste the invitation from a connected device. */
export function InvitationSection({
  busy,
  run,
  setError,
  title,
  inputRef,
}: SyncSession & {
  title: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [invitation, setInvitation] = useState('');
  const info = useInvitationPreview(invitation, setError);
  return (
    <SyncSection
      icon={Link2}
      title={title}
      description="Se o link não abrir o aplicativo, cole o convite do aparelho conectado."
    >
      <label className="field">
        <span>Convite do cofre</span>
        <textarea
          aria-label="Convite do cofre"
          ref={inputRef}
          value={invitation}
          onChange={(e) => setInvitation(e.target.value)}
        />
      </label>
      {info && (
        <div className="sync-invite-preview">
          <p>Cofre pessoal · {new URL(info.endpoint).host}</p>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => void run('pairing-connect', [invitation])}
          >
            Conectar
          </button>
        </div>
      )}
    </SyncSection>
  );
}

/** Waiting for approval; a refused or expired invitation can be replaced. */
export function PairingProgress({ status, busy, run, setError }: SyncSession) {
  const [invitation, setInvitation] = useState('');
  const info = useInvitationPreview(invitation, setError);
  return (
    <SyncSection
      icon={Smartphone}
      title={pairingStepTitle(status.pairingStep)}
      description="Confira o mesmo código no aparelho conectado antes de aprovar."
    >
      <div className="sync-fingerprint">
        <span>Código de segurança</span>
        <code>{status.pairingCode}</code>
      </div>
      {canReplaceInvitation(status.pairingError) && (
        <label className="field">
          <span>Cole um novo convite do aparelho conectado</span>
          <textarea
            aria-label="Novo convite do cofre"
            value={invitation}
            onChange={(e) => setInvitation(e.target.value)}
          />
        </label>
      )}
      {info && info.id !== status.pairingInviteId && (
        <div className="sync-invite-preview">
          <p>Cofre pessoal · {new URL(info.endpoint).host}</p>
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => void run('pairing-connect', [invitation])}
          >
            Conectar
          </button>
        </div>
      )}
      {status.pairingError && <p role="alert">{status.pairingError}</p>}
    </SyncSection>
  );
}
