import { describe, expect, it, vi } from 'vitest';
import { SyncController, type SyncOptions, type SyncSaved } from './sync';
import { assertServerResetIntent } from './server-reset';

function client(value: unknown, phase: 'pending-unlink' | 'ready' = 'ready') {
  let saved: SyncSaved = {
    endpoint: 'https://sync.example.com',
    serverReset: {
      phase,
      backupPath: '/private/backup.sqlite',
      intent: value as never,
    },
  };
  const options: SyncOptions = {
    db: { read: vi.fn(async () => []), run: vi.fn(async () => undefined) },
    secrets: { load: vi.fn(), store: vi.fn(), remove: vi.fn() },
    sodium: {} as SyncOptions['sodium'],
    dialect: 'desktop',
    storage: {
      load: async () => structuredClone(saved),
      save: vi.fn(async (s) => {
        saved = structuredClone(s);
      }),
    },
    backup: vi.fn(),
    login: vi.fn(),
  };
  return { options, sync: new SyncController(options), saved: () => saved };
}
describe('durable recreated-server intention', () => {
  it.each([undefined, null, '', 'create', 'source', 'JOIN-EXISTING', false])(
    'rejects missing/unknown intent %j before backup or unlink',
    async (value) => {
      expect(() => assertServerResetIntent(value)).toThrow('Escolha');
      const c = client(value, 'pending-unlink');
      await expect(c.sync.resumeRecoveryOnStartup()).rejects.toThrow('Escolha');
      await expect(
        c.sync.resetForRecreatedServer(
          'https://sync.example.com',
          value as never,
          true,
        ),
      ).rejects.toThrow('Escolha');
      expect(c.options.db.run).not.toHaveBeenCalled();
      expect(c.options.backup).not.toHaveBeenCalled();
      expect(c.options.storage.save).not.toHaveBeenCalled();
      c.sync.coordinator.dispose();
    },
  );
  it('join-existing blocks create before login, provisioning or remote calls, even in a new controller', async () => {
    const c = client('join-existing');
    await c.sync.resumeRecoveryOnStartup();
    for (const controller of [c.sync, new SyncController(c.options)]) {
      await expect(controller.create()).rejects.toThrow(
        'Este fluxo não cria outro cofre',
      );
      controller.coordinator.dispose();
    }
    expect(c.options.login).not.toHaveBeenCalled();
    expect(c.options.db.run).not.toHaveBeenCalled();
    expect(c.options.storage.save).not.toHaveBeenCalled();
    expect(c.saved().serverReset?.intent).toBe('join-existing');
  });
  it.each(['source-of-truth', 'join-existing'] as const)(
    'startup resumes pending unlink without changing %s or creating another backup',
    async (intent) => {
      const c = client(intent, 'pending-unlink');
      await c.sync.resumeRecoveryOnStartup();
      expect(c.options.db.run).toHaveBeenCalledTimes(1);
      expect(c.saved().serverReset).toEqual({
        phase: 'ready',
        backupPath: '/private/backup.sqlite',
        intent,
      });
      const restarted = new SyncController(c.options);
      await restarted.resumeRecoveryOnStartup();
      restarted.coordinator.dispose();
      expect(c.options.db.run).toHaveBeenCalledTimes(1);
      expect(c.options.backup).not.toHaveBeenCalled();
      c.sync.coordinator.dispose();
    },
  );
});
