import React from 'react';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResetIntent, SyncStatus } from '@lionpocket/sync-local';
import { SyncPanel as DesktopSyncPanel } from '../../desktop/src/ui/SyncPanel';
import { SyncPanel as MobileSyncPanel } from '../../mobile/src/ui/SyncPanel';

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
function status(
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

describe.each(['desktop', 'android'] as const)(
  '%s recreated-server UX',
  (platform) => {
    async function mount(initial: SyncStatus) {
      let current = initial;
      const subscribers = new Set<() => void>();
      const controller = {
        status: async () => current,
        subscribe: (f: () => void) => {
          subscribers.add(f);
          return () => subscribers.delete(f);
        },
        coordinator: {},
        create: vi.fn(async () => undefined),
        resetForRecreatedServer: vi.fn(
          async (
            _endpoint: string,
            intent: ServerResetIntent,
            confirmed: boolean,
          ) => {
            if (!confirmed) throw new Error('Missing consent');
            current = status('local', intent);
          },
        ),
        inspectPairingInvitation: vi.fn(async (_invitation: string) => ({
          id: 'invite-id',
          endpoint: 'https://sync.example.com',
        })),
        connectInvitation: vi.fn(async (_invitation: string) => undefined),
      };
      const command = vi.fn(async (name: string, args: unknown[]) => {
        if (name === 'server-reset')
          return controller.resetForRecreatedServer(
            String(args[0]),
            args[1] as ServerResetIntent,
            args[2] === true,
          );
        if (name === 'create') return controller.create();
        if (name === 'pairing-inspect')
          return controller.inspectPairingInvitation(String(args[0]));
        if (name === 'pairing-connect')
          return controller.connectInvitation(String(args[0]));
        throw new Error('Unexpected command: ' + name);
      });
      runtime.controller = controller;
      vi.stubGlobal('window', {
        lionPocket: {
          syncStatus: controller.status,
          syncCommand: command,
          onSyncChanged: controller.subscribe,
        },
      });
      await act(async () => {
        renderer = create(
          React.createElement(
            platform === 'desktop' ? DesktopSyncPanel : MobileSyncPanel,
            { onChanged: async () => undefined },
          ),
        );
      });
      const button = (label: string) =>
        renderer!.root.findAll((node) =>
          platform === 'desktop'
            ? node.type === 'button' && text(node).trim() === label
            : (node.type === ('mobile-button' as unknown) &&
                node.props.label === label) ||
              (node.type === ('mobile-pressable' as unknown) &&
                node.props.accessibilityLabel === label),
        )[0];
      const press = async (label: string) => {
        expect(button(label)).toBeTruthy();
        expect(button(label).props.disabled).not.toBe(true);
        await act(async () => {
          const b = button(label);
          (platform === 'desktop' ? b.props.onClick : b.props.onPress)();
        });
      };
      return {
        controller,
        command,
        button,
        press,
        change: async (s: SyncStatus) => {
          current = s;
          await act(async () => {
            subscribers.forEach((f) => f());
          });
        },
      };
    }
    it.each(['source-of-truth', 'join-existing'] as const)(
      'requires choosing %s before backup/unlink and shows its correct continuation',
      async (intent) => {
        const ui = await mount(status('bound'));
        const labels = [
          'Usar este aparelho como fonte de verdade',
          'Conectar este aparelho a um cofre já recriado',
        ];
        // Both choices are visible without opening Advanced or a disclosure.
        expect(text(renderer!.root)).toContain(
          'Servidor de sincronização recriado',
        );
        if (platform === 'desktop') {
          expect(
            renderer!.root
              .findAllByType('details')
              .filter((n) =>
                text(n).includes('Servidor de sincronização recriado'),
              ),
          ).toHaveLength(0);
          const choices = renderer!.root
            .findAllByType('input')
            .filter((n) => n.props.type === 'radio');
          expect(choices.map((n) => n.props.value)).toEqual([
            'source-of-truth',
            'join-existing',
          ]);
          for (const label of labels)
            expect(text(renderer!.root)).toContain(label);
          expect(
            ui.button('Preservar backup e remover vínculo antigo').props
              .disabled,
          ).toBe(true);
          await act(async () => {
            choices.find((n) => n.props.value === intent)!.props.onChange();
          });
          await act(async () => {
            renderer!.root
              .findAllByType('input')
              .find((n) => n.props.type === 'checkbox')!
              .props.onChange({ target: { checked: true } });
          });
        } else {
          for (const label of labels) expect(ui.button(label)).toBeTruthy();
          expect(
            ui.button('Preservar backup e remover vínculo antigo').props
              .disabled,
          ).toBe(true);
          await ui.press(labels[intent === 'source-of-truth' ? 0 : 1]);
          await ui.press('Entendo que o remoto anterior será abandonado e que o backup será preservado antes de remover o vínculo.');
        }
        expect(text(renderer!.root)).toContain('cofres independentes');
        expect(text(renderer!.root)).toContain(
          'Este fluxo não cria um novo cofre',
        );
        await ui.press('Preservar backup e remover vínculo antigo');
        expect(ui.controller.resetForRecreatedServer).toHaveBeenCalledWith(
          'https://sync.example.com',
          intent,
          true,
        );
        expect(text(renderer!.root)).toContain(
          'Backup criado: /private/backup.sqlite',
        );
        expect(!!ui.button('Criar novo cofre usando estes dados')).toBe(
          intent === 'source-of-truth',
        );
        expect(!!ui.button('Conectar por convite')).toBe(
          intent === 'join-existing',
        );
        expect(ui.button('Configurar sincronização')).toBeUndefined();
        if (intent === 'source-of-truth') {
          await ui.press('Criar novo cofre usando estes dados');
          expect(ui.controller.create).toHaveBeenCalledTimes(1);
        } else {
          await ui.press('Conectar por convite');
          expect(ui.controller.create).not.toHaveBeenCalled();
        }
      },
    );
    it.each(['source-of-truth', 'join-existing'] as const)(
      'remount uses durable ready intention %s, without temporary selection',
      async (intent) => {
        const ui = await mount(status('local', intent));
        expect(text(renderer!.root)).toContain('/private/backup.sqlite');
        expect(!!ui.button('Criar novo cofre usando estes dados')).toBe(
          intent === 'source-of-truth',
        );
        expect(!!ui.button('Conectar por convite')).toBe(
          intent === 'join-existing',
        );
        expect(ui.button('Configurar sincronização')).toBeUndefined();
        expect(ui.button('Conectar')).toBeUndefined();
        if (intent === 'join-existing') {
          expect(ui.controller.create).not.toHaveBeenCalled();
          if (platform === 'android') {
            expect(ui.button('Escanear QR Code')).toBeTruthy();
            expect(text(renderer!.root)).toContain('abra o link LPV2');
            expect(
              renderer!.root.findAll(
                (n) => n.props.accessibilityLabel === 'Convite do cofre',
              ),
            ).toHaveLength(1);
          } else
            expect(
              renderer!.root
                .findAllByType('textarea')
                .find((n) => n.props['aria-label'] === 'Convite do cofre'),
            ).toBeTruthy();
        }
      },
    );
    it('join-existing validates a pasted invitation and connects without a creation command', async () => {
      const ui = await mount(status('local', 'join-existing'));
      const invitation = 'lionpocket://pair/LPV2.fixture';
      await act(async () => {
        if (platform === 'desktop')
          renderer!.root
            .findAllByType('textarea')
            .find((n) => n.props['aria-label'] === 'Convite do cofre')!
            .props.onChange({ target: { value: invitation } });
        else
          renderer!.root
            .findAll(
              (n) => n.props.accessibilityLabel === 'Convite do cofre',
            )[0]
            .props.onChangeText(invitation);
      });
      expect(ui.controller.inspectPairingInvitation).toHaveBeenCalledWith(
        invitation,
      );
      await ui.press('Conectar');
      expect(ui.controller.connectInvitation).toHaveBeenCalledWith(invitation);
      expect(ui.controller.create).not.toHaveBeenCalled();
      expect(ui.button('Criar novo cofre usando estes dados')).toBeUndefined();
    });
    it('changing the choice invalidates consent before unlink', async () => {
      const ui = await mount(status('bound'));
      if (platform === 'desktop') {
        const choose = async (intent: ServerResetIntent) =>
          act(async () =>
            renderer!.root
              .findAllByType('input')
              .find((n) => n.props.value === intent)!
              .props.onChange(),
          );
        await choose('source-of-truth');
        await act(async () =>
          renderer!.root
            .findAllByType('input')
            .find((n) => n.props.type === 'checkbox')!
            .props.onChange({ target: { checked: true } }),
        );
        await choose('join-existing');
      } else {
        await ui.press('Usar este aparelho como fonte de verdade');
        await ui.press('Entendo que o remoto anterior será abandonado e que o backup será preservado antes de remover o vínculo.');
        await ui.press('Conectar este aparelho a um cofre já recriado');
      }
      expect(
        ui.button('Preservar backup e remover vínculo antigo').props.disabled,
      ).toBe(true);
      expect(ui.controller.resetForRecreatedServer).not.toHaveBeenCalled();
    });
    it('a setup form already open cannot leak creation into join-existing ready', async () => {
      const ui = await mount(status('local'));
      await ui.press('Configurar sincronização');
      expect(ui.button('Conectar')).toBeTruthy();
      await ui.change(status('local', 'join-existing'));
      expect(ui.button('Conectar')).toBeUndefined();
      expect(ui.button('Configurar sincronização')).toBeUndefined();
      expect(ui.button('Criar novo cofre usando estes dados')).toBeUndefined();
      expect(ui.button('Conectar por convite')).toBeTruthy();
      expect(ui.controller.create).not.toHaveBeenCalled();
    });
  },
);
