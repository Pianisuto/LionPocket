import { AppState } from 'react-native';
import { betaSync, privateBeta } from './beta';
/** Mounted at the app root, never a background service. Cleanup also handles async initialization. */
export function startBetaForeground(onCompleted: () => void): () => void {
  if (!privateBeta) return () => {};
  let disposed = false;
  let beta: Awaited<ReturnType<typeof betaSync>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastCompleted: string | undefined;
  const subscription = AppState.addEventListener('change', (state) =>
    beta?.setForeground(state === 'active'),
  );
  void betaSync()
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
