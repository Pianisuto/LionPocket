import { describe, expect, it, vi } from 'vitest';
import { handlePairingInstances, pairingArgument, PairingLinkInbox, registerPairingProtocol } from './pairingLinks';

const link = 'lionpocket://pair/LPV2.synthetic';
describe('OS LPV2 entry points', () => {
  const instance = (locked = true) => {
    const listeners = new Map<string, (...args: any[]) => void>();
    return { listeners, requestSingleInstanceLock: vi.fn(() => locked), quit: vi.fn(), on: (event: string, listener: (...args: any[]) => void) => listeners.set(event, listener) };
  };
  it('cold start consumes the URI wherever the OS puts it in argv', () => {
    const app = instance(), receive = vi.fn();
    expect(handlePairingInstances(app, ['app', link, '--other'], receive, vi.fn())).toBe(true);
    expect(receive).toHaveBeenCalledExactlyOnceWith(link);
    expect(pairingArgument(['--url=https://example.org', 'LPV2.synthetic'])).toBeUndefined();
  });
  it('warm start forwards to the existing instance and restores/focuses it', () => {
    const app = instance(), receive = vi.fn(), show = vi.fn();
    handlePairingInstances(app, ['app'], receive, show);
    app.listeners.get('second-instance')!({}, ['app', '--other', link]);
    expect(receive).toHaveBeenCalledExactlyOnceWith(link);
    expect(show).toHaveBeenCalledOnce();
  });
  it('a second process quits before registering any app handlers/windows', () => {
    const app = instance(false);
    expect(handlePairingInstances(app, [link], vi.fn(), vi.fn())).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.listeners.size).toBe(0);
  });
  it('macOS open-url is registered synchronously and prevents default', () => {
    const app = instance(), receive = vi.fn(), event = { preventDefault: vi.fn() };
    handlePairingInstances(app, [], receive, vi.fn());
    app.listeners.get('open-url')!(event, link);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith(link);
  });
  it.each(['--squirrel-install', '--squirrel-updated', '--squirrel-firstrun', 'normal'])('Windows installed registration on %s uses the installed executable', arg => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true), removeAsDefaultProtocolClient: vi.fn(() => true) };
    registerPairingProtocol(app, 'win32', ['app', arg], true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith('lionpocket');
  });
  it('uninstall unregisters; obsolete/dev do not replace the installed handler', () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true), removeAsDefaultProtocolClient: vi.fn(() => true) };
    registerPairingProtocol(app, 'win32', ['--squirrel-uninstall'], true);
    registerPairingProtocol(app, 'win32', ['--squirrel-obsolete'], true);
    registerPairingProtocol(app, 'win32', [], false);
    registerPairingProtocol(app, 'linux', [], true);
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledExactlyOnceWith('lionpocket');
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
  it('cold-start valid invite waits for renderer; delivery is consumed once', async () => {
    const inspect = vi.fn(async () => ({ id: 'id', endpoint: 'https://sync.example.org' })), notify = vi.fn();
    const inbox = new PairingLinkInbox(inspect, notify);
    await inbox.receive(link);
    expect(notify).toHaveBeenCalledOnce();
    expect(inbox.take()).toEqual({ invitation: link, endpoint: 'https://sync.example.org', id: 'id' });
    expect(inbox.take()).toBeNull();
  });
  it.each(['https://attacker.invalid', 'lionpocket://pair/unsupported.secret', link + '?redirect=evil', 'lionpocket://other/LPV2.secret'])('rejects malformed transport without starting onboarding: %s', async value => {
    const inspect = vi.fn(), inbox = new PairingLinkInbox(inspect, vi.fn());
    await inbox.receive(value);
    expect(inbox.take()).toEqual({ error: 'Convite inválido' });
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each([['invite_expired', 'Convite expirado'], ['invite_revoked', 'Convite cancelado'], ['secret raw error LPV2.canary', 'Servidor indisponível']])('validation error %s is friendly and contains no invitation', async (code, message) => {
    const inbox = new PairingLinkInbox(async () => { throw new Error(code); }, vi.fn());
    await inbox.receive(link);
    expect(inbox.take()).toEqual({ error: message });
  });
  it('a late validation cannot replace a newer intent', async () => {
    let finish!: (value: { id: string; endpoint: string }) => void;
    const inbox = new PairingLinkInbox(() => new Promise(resolve => { finish = resolve; }), vi.fn());
    const first = inbox.receive(link);
    await inbox.receive('lionpocket://bad');
    finish({ id: 'old', endpoint: 'https://old.invalid' });
    await first;
    expect(inbox.take()).toEqual({ error: 'Convite inválido' });
  });
  it('a renderer StrictMode unsubscribe does not lose cold-start intent; stale acknowledgements preserve newer links', async () => {
    const inbox = new PairingLinkInbox(async () => ({ id: 'id', endpoint: 'https://sync.example.org' }), vi.fn());
    await inbox.receive(link);
    const first = inbox.peek()!;
    expect(inbox.peek()).toEqual(first);
    await inbox.receive('lionpocket://pair/LPV2.new');
    inbox.acknowledge(first.generation);
    expect(inbox.peek()?.event.invitation).toBe('lionpocket://pair/LPV2.new');
    inbox.acknowledge(inbox.peek()!.generation);
    expect(inbox.peek()).toBeNull();
  });
});
