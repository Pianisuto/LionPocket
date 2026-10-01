import { AppState } from 'react-native';
import { syncController } from './sync';
/** Mounted at the app root, never a background service. Cleanup also handles async initialization. */
export function startSyncForeground(onCompleted: () => void): () => void {
  let disposed = false;
  let beta: Awaited<ReturnType<typeof syncController>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastCompleted: string | undefined;
  const subscription = AppState.addEventListener('change', (state) =>
    beta?.setForeground(state === 'active'),
  );
  void syncController()
    .then((controller) => {
      if (disposed) return;
      beta = controller;
      unsubscribe = beta.subscribe(() => {
        if (beta!.coordinator.lastCompletedAt !== lastCompleted) {
          lastCompleted = beta!.coordinator.lastCompletedAt;
          if (AppState.currentState === 'active') onCompleted();
        }
      });
      beta.setForeground(AppState.currentState === 'active');
    })
    .catch(() => {
      /* Native sync initialization cannot prevent local app use. */
    });
  return () => {
    disposed = true;
    subscription.remove();
    unsubscribe?.();
    beta?.setForeground(false);
  };
}

/** Transitional code alias; the normal app uses the generic foreground adapter. */
export const startBetaForeground = startSyncForeground;
