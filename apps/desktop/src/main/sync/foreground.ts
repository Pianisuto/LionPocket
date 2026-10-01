/** Lifecycle adapter only. Scheduling and coalescing stay in the shared bank coordinator. */
export function desktopForeground(
  app: {
    on(
      event: 'browser-window-focus' | 'browser-window-blur',
      listener: () => void,
    ): unknown;
    removeListener(
      event: 'browser-window-focus' | 'browser-window-blur',
      listener: () => void,
    ): unknown;
  },
  isFocused: () => boolean,
  setForeground: (active: boolean) => void,
): () => void {
  const focus = () => setForeground(true);
  const blur = () => setForeground(isFocused());
  app.on('browser-window-focus', focus);
  app.on('browser-window-blur', blur);
  setForeground(isFocused());
  return () => {
    app.removeListener('browser-window-focus', focus);
    app.removeListener('browser-window-blur', blur);
    setForeground(false);
  };
}
