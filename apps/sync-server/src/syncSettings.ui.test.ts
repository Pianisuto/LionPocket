import React from 'react';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResetIntent, SyncStatus } from '@lionpocket/sync-local';
import { SyncPanel as DesktopSyncPanel } from '../../desktop/src/ui/settings/sync/SyncPanel';
import { SyncPanel as MobileSyncPanel } from '../../mobile/src/ui/settings/sync/SyncPanel';

const runtime = vi.hoisted(() => ({ controller: undefined as unknown }));
vi.mock('../../mobile/src/sync/sync', () => ({
  syncController: async () => runtime.controller,
  betaEndpoint: '',
}));
vi.mock('react-native', () => ({
  Text: 'mobile-text',
  TextInput: 'mobile-input',
  View: 'mobile-view',
  Pressable: 'mobile-pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Image: 'mobile-image',
  Share: {},
  NativeModules: {},
}));
vi.mock('../../mobile/src/ui/Appearance', async () => {
  const { darkColors } = await import('../../mobile/src/ui/theme');
  return { useAppearance: () => ({ colors: darkColors }) };
});
vi.mock('../../mobile/src/ui/Icon', () => ({ Icon: 'mobile-icon' }));
vi.mock('../../mobile/src/ui/components', async () => {
  const React = await import('react');
  return {
    useStyles: () => ({}),
    Button: (props: Record<string, unknown>) =>
      React.createElement('mobile-button', props),
  };
});
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function baseStatus(
  phase: SyncStatus['phase'],
  intent?: ServerResetIntent,
): SyncStatus {
  return {
    phase,
    endpoint: 'https://sync.example.com',
    activity: phase === 'bound' ? 'ready' : 'local',
    serverReset: intent
      ? { phase: 'ready', intent, backupPath: '/private/backup.sqlite' }
      : undefined,
    owner: false,
    devices: [],
    pairingRequests: [],
    pairingInviteId: null,
    pairingCode: '',
    pairingError: null,
    pairingStep: undefined,
    recoveryPhase: null,
    recoveryPackage: '',
    recoveryVersion: '0',
    anchorRecoveryAvailable: false,
    compatibilityMessage: null,
    lastCompletedAt: null,
    discovered: null,
    restoreReview: false,
    activeKeyVersion: 1,
    deviceId: '',
    paused: false,
    counts: {},
    sync: null,
    reviews: [],
    quarantine: [],
    mode: 'disabled',
  };
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe.each(['desktop', 'android'] as const)('%s sync settings flows', (platform) => {
  async function mount(patch: Partial<SyncStatus> = {}) {
    let current: SyncStatus = { ...baseStatus('local'), ...patch };
    const subscribers = new Set<() => void>();
    const changed = vi.fn(async () => undefined);
    const controller = {
      status: vi.fn(async () => current),
      subscribe: (f: () => void) => { subscribers.add(f); return () => subscribers.delete(f); },
      coordinator: {},
      unlinkServer: vi.fn(async (_confirmed: boolean) => { current = { ...baseStatus('local'), endpoint: '' }; }),
      configure: vi.fn(async (_endpoint: string) => undefined),
      create: vi.fn(async () => { current = { ...current, phase: 'bound', activity: 'ready', owner: true }; }),
      sync: vi.fn(async () => undefined),
      pause: vi.fn(async (paused: boolean) => { current = { ...current, paused, activity: paused ? 'paused' : 'ready' }; }),
      inspectPairingInvitation: vi.fn(async () => ({ id: 'invite', endpoint: 'https://sync.example.com' })),
      connectInvitation: vi.fn(async (_value: string) => { current = { ...current, phase: 'pairing', pairingCode: '123 456' }; }),
      approve: vi.fn(async (_id: string) => undefined),
      generateRecovery: vi.fn(async () => ({ code: 'LP1.secret' })),
      confirmRecovery: vi.fn(async (_code: string) => { current = { ...current, recoveryVersion: '1' }; }),
      reconnectRestored: vi.fn(async (_consent: boolean) => undefined),
      prepareServerRecovery: vi.fn(async (_consent: boolean) => {
        current = { ...current, recoveryPhase: 'recovery_pending_confirmation' };
        return { code: 'LP1.server' };
      }),
      confirmServerRecovery: vi.fn(async (_code: string) => { current = { ...current, recoveryPhase: 'prepared' }; }),
      activateServerRecovery: vi.fn(async (_consent: boolean) => { current = { ...current, recoveryPhase: 'recovered' }; }),
    };
    const command = vi.fn(async (name: string, args: unknown[]) => {
      switch (name) {
        case 'unlink': return controller.unlinkServer(args[0] === true);
        case 'setup': await controller.configure(String(args[0])); return controller.create();
        case 'create': return controller.create();
        case 'sync': return controller.sync();
        case 'pause': return controller.pause(args[0] === true);
        case 'pairing-inspect': return controller.inspectPairingInvitation();
        case 'pairing-connect': return controller.connectInvitation(String(args[0]));
        case 'approve': return controller.approve(String(args[0]));
        case 'recovery-generate': return controller.generateRecovery();
        case 'recovery-confirm': return controller.confirmRecovery(String(args[0]));
        case 'reconnect': return controller.reconnectRestored(args[0] === true);
        case 'server-recovery-prepare': return controller.prepareServerRecovery(args[0] === true);
        case 'server-recovery-confirm': return controller.confirmServerRecovery(String(args[0]));
        case 'server-recovery-activate': return controller.activateServerRecovery(args[0] === true);
        default: throw new Error('Unexpected command: ' + name);
      }
    });
    runtime.controller = controller;
    vi.stubGlobal('window', { lionPocket: { syncStatus: controller.status, syncCommand: command, onSyncChanged: controller.subscribe } });
    await act(async () => { renderer = create(React.createElement(platform === 'desktop' ? DesktopSyncPanel : MobileSyncPanel, { onChanged: changed })); });
    const button = (requested: string) => {
      const label = platform === 'android' && requested === 'Pausar' ? 'Pausar mantendo pendências' : platform === 'android' && requested === 'Retomar' ? 'Retomar sincronização' : requested;
      return renderer!.root.findAll((node) => platform === 'desktop'
      ? node.type === 'button' && text(node).trim() === label
      : (node.type === 'mobile-button' as unknown && node.props.label === label) || (node.type === 'mobile-pressable' as unknown && node.props.accessibilityLabel === label))[0];
    };
    const press = async (label: string) => {
      const b = button(label);
      expect(b, label).toBeTruthy();
      expect(b.props.disabled).not.toBe(true);
      await act(async () => (platform === 'desktop' ? b.props.onClick : b.props.onPress)());
    };
    const input = async (label: string, value: string) => {
      const node = renderer!.root.findAll((n) => platform === 'desktop'
        ? ['input', 'textarea'].includes(String(n.type)) && n.props['aria-label'] === label
        : n.type === 'mobile-input' as unknown && n.props.accessibilityLabel === label)[0];
      expect(node, label).toBeTruthy();
      await act(async () => platform === 'desktop' ? node.props.onChange({ target: { value } }) : node.props.onChangeText(value));
    };
    const change = async (patch: Partial<SyncStatus>) => {
      current = { ...current, ...patch };
      await act(async () => subscribers.forEach((f) => f()));
    };
    return { controller, changed, button, press, input, change, subscribers };
  }
  it('requires confirmation, supports cancellation, and returns to local setup after unlink', async () => {
    const ui = await mount({ phase: 'bound', activity: 'ready' });
    expect(ui.button('Confirmar desvinculação')).toBeUndefined();
    await ui.press('Desvincular servidor');
    expect(text(renderer!.root)).toContain('Seus dados financeiros locais serão mantidos');
    expect(text(renderer!.root)).toContain('alterações ainda não sincronizadas');
    expect(text(renderer!.root)).toContain('dados de outros aparelhos não serão apagados');
    await ui.press('Cancelar');
    expect(ui.controller.unlinkServer).not.toHaveBeenCalled();
    await ui.press('Desvincular servidor');
    await ui.press('Confirmar desvinculação');
    expect(ui.controller.unlinkServer).toHaveBeenCalledExactlyOnceWith(true);
    expect(ui.button('Desvincular servidor')).toBeUndefined();
    expect(ui.button('Configurar sincronização')).toBeTruthy();
    expect(text(renderer!.root)).toContain('Somente neste aparelho');
    expect(ui.controller.create).not.toHaveBeenCalled();
  });
  it.each(['pairing', 'creating'] as const)('allows unlink during %s without remote access', async phase => {
    const ui = await mount({ phase, activity: 'action-required' });
    await ui.press('Desvincular servidor');
    await ui.press('Confirmar desvinculação');
    expect(ui.controller.unlinkServer).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('keeps the confirmed action available to retry after cleanup fails', async () => {
    const ui = await mount({ phase: 'bound', activity: 'unavailable' });
    ui.controller.unlinkServer.mockRejectedValueOnce(new Error('Não foi possível limpar as credenciais locais'));
    await ui.press('Desvincular servidor');
    await ui.press('Confirmar desvinculação');
    expect(text(renderer!.root)).toContain('Servidor indisponível');
    expect(ui.button('Confirmar desvinculação').props.disabled).toBe(false);
    await ui.press('Confirmar desvinculação');
    expect(ui.controller.unlinkServer).toHaveBeenCalledTimes(2);
    expect(ui.button('Configurar sincronização')).toBeTruthy();
  });
  it('exposes only unlink retry when a configured device has pending cleanup', async () => {
    const ui = await mount({ phase: 'local', activity: 'action-required', unlinkPending: true });
    expect(ui.button('Configurar sincronização')).toBeUndefined();
    expect(text(renderer!.root)).toContain('Desvinculação pendente');
    await ui.press('Desvincular servidor');
    await ui.press('Confirmar desvinculação');
    expect(ui.controller.unlinkServer).toHaveBeenCalledExactlyOnceWith(true);
    expect(ui.button('Configurar sincronização')).toBeTruthy();
  });
  it('configures and creates a vault, then synchronizes and pauses/resumes', async () => {
    const ui = await mount();
    await ui.press('Configurar sincronização');
    await ui.input('Servidor próprio', 'https://sync.example.com');
    if (platform === 'desktop') await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    else await ui.press('Conectar');
    expect(ui.controller.configure).toHaveBeenCalledWith('https://sync.example.com');
    expect(ui.controller.create).toHaveBeenCalledOnce();
    await ui.press('Sincronizar agora');
    expect(ui.controller.sync).toHaveBeenCalledOnce();
    await ui.press('Pausar');
    expect(ui.controller.pause).toHaveBeenLastCalledWith(true);
    expect(ui.button('Sincronizar agora').props.disabled).toBe(true);
    await ui.press('Retomar');
    expect(ui.controller.pause).toHaveBeenLastCalledWith(false);
    expect(ui.changed).toHaveBeenCalled();
  });
  it('previews the invitation and displays the security code while waiting for approval', async () => {
    const ui = await mount();
    await ui.input('Convite do cofre', 'lionpocket://pair/LPV2.fixture');
    expect(ui.controller.inspectPairingInvitation).toHaveBeenCalled();
    await ui.press('Conectar');
    expect(ui.controller.connectInvitation).toHaveBeenCalledWith('lionpocket://pair/LPV2.fixture');
    expect(text(renderer!.root)).toContain('123 456');
    expect(ui.controller.create).not.toHaveBeenCalled();
  });
  it('approves a requested device and confirms a generated recovery code', async () => {
    const ui = await mount({ phase: 'bound', owner: true, activity: 'ready', pairingRequests: [{ deviceId: 'new-device', deviceName: 'Celular', securityCode: '123 456' } as SyncStatus['pairingRequests'][number]] });
    expect(text(renderer!.root)).toContain('123 456');
    await ui.press('Aprovar aparelho');
    expect(ui.controller.approve).toHaveBeenCalledWith('new-device');
    if (platform === 'android') await ui.press('Recuperação e proteção');
    await ui.press('Gerar código de recuperação');
    expect(ui.button('Confirmar código de recuperação').props.disabled).toBe(true);
    await ui.input(platform === 'desktop' ? 'Digite o código que você guardou' : 'Código de recuperação guardado', 'LP1.secret');
    await ui.press('Confirmar código de recuperação');
    expect(ui.controller.confirmRecovery).toHaveBeenCalledWith('LP1.secret');
  });
  it('requires review consent before reconnecting a restored copy', async () => {
    const ui = await mount({ phase: 'bound', activity: 'paused', restoreReview: true });
    const label = platform === 'desktop' ? 'Reconectar para revisão' : 'Reconectar cópia para revisão';
    expect(ui.button(label).props.disabled).toBe(true);
    expect(ui.button('Sincronizar agora').props.disabled).toBe(true);
    if (platform === 'desktop') await act(async () => renderer!.root.findAllByType('input').find((n) => n.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
    else await ui.press('Revisei a cópia restaurada');
    await ui.press(label);
    expect(ui.controller.reconnectRestored).toHaveBeenCalledWith(true);
  });
  it('prepares, confirms and activates server recovery before exposing management', async () => {
    const ui = await mount({ phase: 'bound', activity: 'paused', owner: true, anchorRecoveryAvailable: true, compatibilityMessage: 'O histórico do servidor mudou.' });
    await ui.press(platform === 'desktop' ? 'Preparar recuperação' : 'Preparar recuperação neste aparelho');
    expect(ui.controller.prepareServerRecovery).toHaveBeenCalledWith(true);
    expect(ui.button('Sincronizar agora')).toBeUndefined();
    expect(ui.button('Adicionar aparelho')).toBeUndefined();
    expect(text(renderer!.root)).toContain('Servidor de sincronização recriado');
    await ui.input(platform === 'desktop' ? 'Digite o código que você guardou' : 'Confirme o código de recuperação do servidor', 'LP1.server');
    await ui.press('Guardei e conferi o código');
    expect(ui.controller.confirmServerRecovery).toHaveBeenCalledWith('LP1.server');
    await ui.press('Ativar sincronização recuperada');
    expect(ui.controller.activateServerRecovery).toHaveBeenCalledWith(true);
    expect(text(renderer!.root)).toContain('Sincronização recuperada');
    expect(ui.button('Sincronizar agora')).toBeTruthy();
  });
  it('blocks simultaneous operations and clears busy after failure', async () => {
    const ui = await mount({ phase: 'bound', activity: 'ready' });
    let fail!: (cause: Error) => void;
    ui.controller.sync.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject; }));
    const b = ui.button('Sincronizar agora');
    await act(async () => {
      (platform === 'desktop' ? b.props.onClick : b.props.onPress)();
      (platform === 'desktop' ? b.props.onClick : b.props.onPress)();
    });
    expect(ui.controller.sync).toHaveBeenCalledOnce();
    expect(ui.button('Pausar').props.disabled).toBe(true);
    await act(async () => fail(new Error('Servidor indisponível')));
    expect(text(renderer!.root)).toContain('Não foi possível concluir esta ação');
    expect(ui.button('Pausar').props.disabled).toBe(false);
  });
  it('ignores older status responses and removes the subscription on unmount', async () => {
    const ui = await mount({ phase: 'bound', activity: 'ready' });
    let finish!: (value: SyncStatus) => void;
    ui.controller.status.mockImplementationOnce(() => new Promise<SyncStatus>((resolve) => { finish = resolve; }));
    await act(async () => ui.subscribers.forEach((f) => f()));
    await ui.change({ activity: 'paused', paused: true });
    expect(ui.button('Retomar')).toBeTruthy();
    await act(async () => finish({ ...baseStatus('bound'), activity: 'ready' }));
    expect(ui.button('Retomar')).toBeTruthy();
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(ui.subscribers.size).toBe(0);
  });
});
