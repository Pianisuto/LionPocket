import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopSecretStore } from './secretStore';
import type { SecretScope } from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
const vault = vi.hoisted(() => ({
  available: true,
  backend: 'gnome_libsecret',
  locked: false,
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => vault.available,
    getSelectedStorageBackend: () => vault.backend,
    encryptString: (value: string) => {
      if (vault.locked) throw new Error('vault locked');
      return Buffer.from(value);
    },
    decryptString: (value: Buffer) => {
      if (vault.locked) throw new Error('vault locked');
      return value.toString();
    },
  },
}));
const directories: string[] = [];
afterEach(() => {
  directories
    .splice(0)
    .forEach((p) => rmSync(p, { recursive: true, force: true }));
  vault.available = true;
  vault.backend = 'gnome_libsecret';
  vault.locked = false;
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'lion-secret-test-'));
  directories.push(directory);
  const scope: SecretScope = {
    installationId: randomUUID(),
    deviceId: randomUUID(),
    serverId: randomUUID(),
    serverEpoch: randomUUID(),
    vaultId: randomUUID(),
    purpose: 'dataKey',
    keyVersion: 1,
  };
  return {
    directory,
    scope,
    store: new DesktopSecretStore(join(directory, 'wrappers')),
  };
}
describe('desktop vault refusal/lifecycle (mocked OS only)', () => {
  it.each(process.platform === 'linux' ? ['unavailable', 'basic_text', 'unknown'] : ['unavailable'])(
    'refuses %s without persisting a fallback, local app remains functional',
    async (condition) => {
      const { directory, scope, store } = setup();
      if (condition === 'unavailable') vault.available = false;
      else vault.backend = condition;
      await expect(store.store(scope, new Uint8Array(32))).rejects.toThrow(
        'unavailable',
      );
      expect(readdirSync(directory)).toEqual([]);
      const bank = new LionPocketDatabase(':memory:');
      try {
        expect(
          bank.saveTransaction({
            kind: 'expense',
            description: 'Local sem cofre',
            plannedAmount: 0,
            dueDate: '2026-09-30',
            status: 'planned',
          }).description,
        ).toBe('Local sem cofre');
      } finally {
        bank.db.close();
      }
    },
  );
  it('unlock errors do not delete or overwrite the last durable wrapper', async () => {
    const { scope, store } = setup();
    const original = new Uint8Array(32).fill(7);
    await store.store(scope, original);
    vault.locked = true;
    await expect(store.load(scope)).rejects.toThrow('locked');
    await expect(
      store.store(scope, new Uint8Array(32).fill(9)),
    ).rejects.toThrow('locked');
    vault.locked = false;
    expect(await store.load(scope)).toEqual(original);
    await store.remove(scope);
    expect(await store.load(scope)).toBeNull();
  });
});
