import { describe, expect, it } from 'vitest';
import type { SyncStatus } from './sync';
import {
  canReplaceInvitation,
  serverRecoveryStep,
  serverRecoveryTitle,
  syncPanelState,
  syncStatusDescription,
  syncStatusTitle,
} from './sync-presentation';

const status = (patch: Partial<SyncStatus>): SyncStatus =>
  ({
    phase: 'local',
    activity: 'local',
    endpoint: '',
    serverReset: undefined,
    recoveryPhase: null,
    anchorRecoveryAvailable: false,
    compatibilityMessage: null,
    sync: null,
    reviews: [],
    quarantine: [],
    ...patch,
  }) as SyncStatus;

describe('sync presentation', () => {
  it('derives the recreated-server continuation from the durable intent', () => {
    const ready = (intent: 'source-of-truth' | 'join-existing') =>
      syncPanelState(
        status({
          serverReset: { phase: 'ready', intent, backupPath: '/backup' },
        } as Partial<SyncStatus>),
      );
    expect(ready('source-of-truth')).toMatchObject({
      resetReady: true,
      creatingFromReset: true,
      joiningRecreated: false,
    });
    expect(ready('join-existing')).toMatchObject({
      resetReady: true,
      creatingFromReset: false,
      joiningRecreated: true,
    });
    expect(
      syncPanelState(
        status({
          phase: 'bound',
          serverReset: { phase: 'ready', intent: 'join-existing', backupPath: '' },
        } as Partial<SyncStatus>),
      ).resetReady,
    ).toBe(false);
  });

  it('hides management while a server recovery is in progress', () => {
    expect(syncPanelState(status({ phase: 'bound', activity: 'ready' })).canManage).toBe(true);
    expect(
      syncPanelState(status({ phase: 'bound', recoveryPhase: 'staging' })).canManage,
    ).toBe(false);
    expect(
      syncPanelState(status({ phase: 'bound', recoveryPhase: 'recovered' })).canManage,
    ).toBe(true);
    expect(
      syncPanelState(
        status({
          phase: 'bound',
          anchorRecoveryAvailable: true,
          compatibilityMessage: 'O histórico do servidor mudou.',
        }),
      ).showServerRecovery,
    ).toBe(true);
  });

  it('maps recovery phases to explicit steps and titles', () => {
    expect(serverRecoveryStep(null)).toBe('start');
    expect(serverRecoveryStep('recovery_pending_confirmation')).toBe('preparing');
    expect(serverRecoveryStep('prepared')).toBe('prepared');
    expect(serverRecoveryStep('remote_active')).toBe('finalizing');
    expect(serverRecoveryStep('recovered')).toBe('recovered');
    expect(serverRecoveryStep('cancelled')).toBe('other');
    expect(serverRecoveryTitle('activation_requested')).toBe('Ativando sincronização');
    expect(serverRecoveryTitle(null)).toBe('Recuperar sincronização');
  });

  it('describes pending changes and paused sync without technical terms', () => {
    const pending = status({
      phase: 'bound',
      activity: 'pending',
      sync: { pending: 2 } as SyncStatus['sync'],
    });
    expect(syncStatusDescription(pending)).toContain('2 alterações aguardando envio');
    expect(syncStatusTitle(status({ phase: 'bound', activity: 'paused' }))).toBe(
      'Sincronização pausada',
    );
    expect(syncStatusDescription(status({}))).toContain('sem conta');
  });

  it('only offers a new invitation after an invitation error', () => {
    expect(canReplaceInvitation('Pedido recusado')).toBe(true);
    expect(canReplaceInvitation('Convite expirado')).toBe(true);
    expect(canReplaceInvitation('Servidor indisponível')).toBe(false);
    expect(canReplaceInvitation(null)).toBe(false);
  });
});
