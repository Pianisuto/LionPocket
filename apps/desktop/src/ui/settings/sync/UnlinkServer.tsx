import { unlinkServerCopy } from '@lionpocket/sync-local';
import { useState } from 'react';
import { Unplug } from 'lucide-react';
import { SyncSection } from './primitives';
import type { SyncSession } from './useSyncSession';

export function UnlinkServer({ busy, run }: SyncSession) {
  const [confirming, setConfirming] = useState(false);
  return (
    <SyncSection icon={Unplug} title={unlinkServerCopy.title} description={unlinkServerCopy.description}>
      {confirming ? (
        <div role="group" aria-label="Confirmar desvinculação do servidor">
          <p>{unlinkServerCopy.confirmation}</p>
          <div className="sync-actions">
            <button className="button" type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button>
            <button className="button" type="button" disabled={busy} onClick={() => void run('unlink', [true])}>{unlinkServerCopy.action}</button>
          </div>
        </div>
      ) : (
        <button className="button" type="button" disabled={busy} onClick={() => setConfirming(true)}>{unlinkServerCopy.title}</button>
      )}
    </SyncSection>
  );
}
