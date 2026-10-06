import { pairingErrorMessage } from '@lionpocket/sync-protocol';
import type { PairingLinkEvent } from '../api';

export const pairingScheme = 'lionpocket';

/** OS arguments are untrusted. Never navigate to them or include them in logs/errors. */
export function pairingArgument(argv: string[]): string | undefined {
  return argv.find(value => /^lionpocket:\/\//i.test(value));
}

/** Latest intent wins; retain cold-start delivery until the renderer subscribes. */
export class PairingLinkInbox {
  receivedCount = 0;
  private generation = 0;
  private pending: PairingLinkEvent | null = null;
  constructor(
    private inspect: (link: string) => Promise<{ id: string; endpoint: string }>,
    private notify: () => void,
  ) {}
  async receive(link: string) {
    const generation = ++this.generation;
    let event: PairingLinkEvent;
    try {
      if (!/^lionpocket:\/\/pair\/LPV2\.[A-Za-z0-9_-]+$/.test(link) || link.length > 4096)
        throw new Error('invite_invalid');
      const info = await this.inspect(link);
      event = { invitation: link, endpoint: info.endpoint, id: info.id };
    } catch (error) {
      event = { error: pairingErrorMessage(error) };
    }
    if (generation !== this.generation) return;
    this.receivedCount++;
    this.pending = event;
    this.notify();
  }
  take() {
    const event = this.pending;
    this.pending = null;
    return event;
  }
  peek() { return this.pending ? { generation: this.generation, event: this.pending } : null; }
  acknowledge(generation: number) { if (generation === this.generation) this.pending = null; }
}

type ProtocolApp = {
  setAsDefaultProtocolClient(scheme: string, executable?: string, args?: string[]): boolean;
  removeAsDefaultProtocolClient(scheme: string): boolean;
};
/** Squirrel invokes the installed executable on install/update, before normal startup. */
export function registerPairingProtocol(app: ProtocolApp, platform: string, argv: string[], packaged: boolean) {
  if (platform !== 'win32' && platform !== 'darwin') return;
  if (!packaged) return; // Never replace the installed application's handler with Electron dev.
  if (argv.includes('--squirrel-uninstall')) app.removeAsDefaultProtocolClient(pairingScheme);
  else if (!argv.includes('--squirrel-obsolete')) app.setAsDefaultProtocolClient(pairingScheme);
}

type InstanceApp = {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
};
export function handlePairingInstances(app: InstanceApp, argv: string[], receive: (link: string) => void, show: () => void) {
  if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
  app.on('second-instance', (_event, args: string[]) => {
    const link = pairingArgument(args);
    if (link) receive(link);
    show();
  });
  // macOS delivers open-url rather than argv, including before ready.
  app.on('open-url', (event, link: string) => { event.preventDefault(); receive(link); show(); });
  const link = pairingArgument(argv);
  if (link) receive(link);
  return true;
}
