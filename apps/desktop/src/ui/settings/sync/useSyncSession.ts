import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '@lionpocket/sync-local';
import { pairingErrorMessage } from '@lionpocket/sync-protocol';

/** Runs one sync command; `onSuccess` sees the result before the status refresh. */
export type SyncRun = (
  action: string,
  args?: unknown[],
  onSuccess?: (result: unknown) => void,
) => Promise<void>;

export type SyncSession = {
  status: SyncStatus;
  busy: boolean;
  run: SyncRun;
  setError: (message: string) => void;
};

/**
 * Status, busy state and errors shared by every sync section. Sections only
 * describe what to run; refresh and error handling stay in one place.
 */
export function useSyncSession(onChanged: () => Promise<void>) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const next = await window.lionPocket.syncStatus?.();
    if (mounted.current && request === revision.current && next) setStatus(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => { if (mounted.current) setError(pairingErrorMessage(e)); });
    const unsubscribe = window.lionPocket.onSyncChanged?.(() => {
      void refresh().catch(() => {
        /* Local use continues if status is unavailable. */
      });
    });
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe?.();
    };
  }, [refresh]);

  const run: SyncRun = useCallback(
    async (action, args = [], onSuccess) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await window.lionPocket.syncCommand!(action, args);
        if (mounted.current) onSuccess?.(result);
        await refresh();
        if (mounted.current) await changed.current();
      } catch (e) {
        if (mounted.current) setError(pairingErrorMessage(e));
        await refresh().catch(() => {
          /* Preserve the operation error. */
        });
      } finally {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );

  return { status, busy, error, run, setError };
}

/** Validates a pasted invitation as the user types, without another button. */
export function useInvitationPreview(
  invitation: string,
  setError: (message: string) => void,
) {
  const [info, setInfo] = useState<{ id: string; endpoint: string }>();
  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    if (invitation.trim())
      void window.lionPocket.syncCommand!('pairing-inspect', [invitation])
        .then((value) => {
          if (!cancelled) {
            setInfo(value as { id: string; endpoint: string });
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
