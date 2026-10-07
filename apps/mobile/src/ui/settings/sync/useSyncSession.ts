import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '@lionpocket/sync-local';
import { pairingErrorMessage } from '@lionpocket/sync-protocol';
import { syncController } from '../../../sync/sync';

export type SyncController = Awaited<ReturnType<typeof syncController>>;

/** Runs one controller operation; status refresh and errors are handled here. */
export type SyncAct = (
  action: (controller: SyncController) => Promise<unknown>,
) => void;

export type SyncSession = {
  status: SyncStatus;
  busy: boolean;
  act: SyncAct;
  setError: (message: string) => void;
};

/**
 * Status, busy state and errors shared by every sync section. Sections only
 * describe what to run; refresh and error handling stay in one place.
 */
export function useSyncSession(onChanged: () => Promise<void>) {
  const [status, setStatus] = useState<SyncStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const next = await (await syncController()).status();
    if (mounted.current && request === revision.current) setStatus(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let lastCompleted: string | undefined;
    void refresh().catch((e) => { if (mounted.current) setError(pairingErrorMessage(e)); });
    void syncController()
      .then((c) => {
        if (!disposed)
          unsubscribe = c.subscribe(() => {
            void refresh().catch(() => {
              /* Status remains best effort; local use continues. */
            });
            if (
              c.coordinator.lastCompletedAt &&
              c.coordinator.lastCompletedAt !== lastCompleted
            ) {
              lastCompleted = c.coordinator.lastCompletedAt;
              void changed.current().catch(() => {
                /* Refresh cannot affect saved data. */
              });
            }
          });
      })
      .catch(() => {
        /* Status remains best effort; local use continues. */
      });
    return () => {
      disposed = true;
      mounted.current = false;
      revision.current++;
      unsubscribe?.();
    };
  }, [refresh]);

  const act: SyncAct = useCallback(
    (action) =>
      void (async () => {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError('');
        try {
          await action(await syncController());
          await refresh();
          if (mounted.current) await changed.current();
        } catch (e) {
          if (mounted.current) setError(pairingErrorMessage(e));
          await refresh().catch(() => {
            /* Preserve the original operation error. */
          });
        } finally {
          pending.current = false;
          if (mounted.current) setBusy(false);
        }
      })(),
    [refresh],
  );

  return { status, busy, error, act, setError };
}

/** Validates a pasted or scanned invitation as soon as it changes. */
export function useInvitationPreview(
  invitation: string,
  setError: (message: string) => void,
) {
  const [info, setInfo] = useState<{ id: string; endpoint: string }>();
  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    if (invitation.trim())
      void syncController()
        .then((c) => c.inspectPairingInvitation(invitation))
        .then((value) => {
          if (!cancelled) {
            setInfo(value);
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(pairingErrorMessage(e));
        });
    return () => {
      cancelled = true;
    };
  }, [invitation, setError]);
  return info;
}

/** Editable server address that follows the saved endpoint when it changes. */
export function useEndpointDraft(saved: string) {
  const [endpoint, setEndpoint] = useState(saved);
  useEffect(() => setEndpoint(saved), [saved]);
  return [endpoint, setEndpoint] as const;
}
