import { useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '@lionpocket/sync-local';
import { pairingErrorMessage } from '@lionpocket/sync-protocol';
import type { PairingLinkEvent } from '../api';

/** The main process validated this intent; Conectar still revalidates before any request. */
export function PairingOnboarding({ intent, onCancel }: { intent: PairingLinkEvent; onCancel: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState(intent.error ?? '');
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void window.lionPocket.syncStatus!().then(value => { if (!disposed) setStatus(value); }).catch(() => { /* Local data remains available if sync status cannot be read. */ }); };
    refresh();
    const unsubscribe = window.lionPocket.onSyncChanged?.(refresh);
    return () => { disposed = true; unsubscribe?.(); };
  }, []);
  useEffect(() => { setError(intent.error ?? ''); }, [intent]);
  const connect = async () => {
    if (flight.current || !intent.invitation) return;
    flight.current = true; setBusy(true); setError('');
    try {
      await window.lionPocket.syncCommand!('pairing-connect', [intent.invitation]);
      setStatus(await window.lionPocket.syncStatus!());
    } catch (e) { setError(pairingErrorMessage(e)); }
    finally { flight.current = false; setBusy(false); }
  };
  const waiting = status?.phase === 'pairing' && status.pairingInviteId === intent.id;
  const ready = status?.phase === 'bound' && status.pairingInviteId === intent.id;
  const alreadyBound = status?.phase === 'bound' && !ready;
  return <div className="sync-panel pairing-onboarding">
    {intent.endpoint && <div className="pairing-onboarding__server"><span>Servidor</span><strong>{new URL(intent.endpoint).host}</strong></div>}
    {ready ? <p role="status">{status.lastCompletedAt ? 'Sincronização pronta' : 'Sincronizando dados…'}</p>
      : waiting ? <>
        <p role="status">Aguardando aprovação no outro aparelho…</p>
        <div className="sync-fingerprint"><span>Código de segurança</span><code>{status.pairingCode}</code></div>
        <p>Confira o mesmo código no aparelho conectado antes de aprovar.</p>
      </> : alreadyBound ? <p>Este aparelho já está conectado a um cofre. Use um aparelho novo para conectar este convite.</p>
        : intent.invitation && <p>Este aparelho pedirá acesso ao seu cofre. A aprovação será feita em um aparelho já conectado.</p>}
    {(error || (waiting && status.pairingError)) && <p role="alert">{error || status?.pairingError}</p>}
    <div className="sync-actions">
      <button className="button" disabled={busy} onClick={onCancel}>{waiting || ready || alreadyBound ? 'Fechar' : 'Cancelar'}</button>
      {intent.invitation && !waiting && !ready && !alreadyBound && <button className="button button--primary" disabled={busy || !status} onClick={() => void connect()}>{busy ? 'Conectando…' : 'Conectar'}</button>}
    </div>
  </div>;
}
