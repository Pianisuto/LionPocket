import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { desktopCrypto } from '../../apps/desktop/src/main/sync/crypto';
import { DesktopSecretStore } from '../../apps/desktop/src/main/sync/secretStore';
import { LionPocketDatabase } from '../../apps/desktop/src/main/database';
import {
  validateSyncBackup,
  secretContext,
  type SecretScope,
} from '@lionpocket/sync-local';
import type { BackupData } from '@lionpocket/core';
import * as protocol from '@lionpocket/sync-protocol';
import { runManualChecks } from './manual-checks.cjs';
// The shared Stage 0 runner contains only fixed public fixtures.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runCryptoChecks } = require('../sync-stage0/crypto-checks.cjs');
const root = resolve(process.env.LIONPOCKET_STAGE1_REPO ?? process.cwd());
const isolated = mkdtempSync(join(tmpdir(), 'lion-stage1-desktop-'));
app.setPath('userData', join(isolated, 'userData'));
app
  .whenReady()
  .then(async () => {
    const sodium = await desktopCrypto();
    const fixture = (name: string) =>
      JSON.parse(
        readFileSync(
          join(root, 'packages/sync-protocol/fixtures', name + '.json'),
          'utf8',
        ),
      );
    const peer = process.argv[3]
      ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
      : undefined;
    const crypto = await runCryptoChecks(
      sodium,
      fixture('crypto'),
      fixture('serialization'),
      protocol,
      (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
      fixture('control'),
      peer,
    );
    const bankPath = join(isolated, 'synthetic-desktop.sqlite'),
      bank = new LionPocketDatabase(bankPath);
    let local;
    try {
      local = await runManualChecks({
        read: async (sql, params = []) =>
          bank.db.prepare(sql).all(...params) as Record<
            string,
            string | number | null
          >[],
        save: (input) => bank.saveTransaction(input),
        settle: (id) => bank.settleTransaction(id),
        remove: (id) => bank.deleteTransaction(id),
        enable: () => bank.enableSyntheticManualSyncPilot(),
      });
      validateSyncBackup(bank.exportData(true) as BackupData);
      const before = JSON.stringify(bank.exportData(true));
      bank.db.close();
      const reopened = new LionPocketDatabase(bankPath);
      try {
        if (JSON.stringify(reopened.exportData(true)) !== before)
          throw new Error('Reopen changed durable data');
      } finally {
        reopened.db.close();
      }
    } catch (error) {
      try {
        bank.db.close();
      } catch {
        /* already closed */
      }
      throw error;
    }
    const storePath = join(isolated, 'secret-wrappers'),
      store = new DesktopSecretStore(storePath);
    const scope: SecretScope = {
      installationId: randomUUID(),
      deviceId: randomUUID(),
      serverId: randomUUID(),
      serverEpoch: randomUUID(),
      vaultId: randomUUID(),
      purpose: 'dataKey',
      keyVersion: 1,
    };
    const key = sodium.randombytes_buf(32);
    let checks = 0;
    const check = (condition: boolean) => {
      if (!condition) throw new Error('Desktop durable secret store');
      checks++;
    };
    try {
      check((await store.load(scope)) === null);
      await store.store(scope, key);
      check(
        sodium.to_hex(
          (await new DesktopSecretStore(storePath).load(scope))!,
        ) === sodium.to_hex(key),
      );
      const files = readdirSync(storePath);
      check(files.length === 1);
      const ciphertext = readFileSync(join(storePath, files[0]));
      check(!ciphertext.includes(Buffer.from(key)));
      const wrong = { ...scope, deviceId: randomUUID() };
      const wrongPath = join(
        storePath,
        createHash('sha256').update(secretContext(wrong)).digest('hex') +
          '.bin',
      );
      writeFileSync(wrongPath, ciphertext);
      let refused = false;
      try {
        await store.load(wrong);
      } catch {
        refused = true;
      }
      check(refused);
      await store.remove(wrong);
      writeFileSync(
        join(storePath, files[0]),
        Buffer.from('corrupted wrapper'),
      );
      refused = false;
      try {
        await store.load(scope);
      } catch {
        refused = true;
      }
      check(refused);
      await store.store(scope, key);
      await store.remove(scope);
      check((await store.load(scope)) === null);
    } finally {
      await store.remove(scope);
      sodium.memzero(key);
    }
    const report = {
      ...crypto,
      runtime: 'Electron main app adapters',
      electron: process.versions.electron,
      node: process.versions.node,
      libsodium: sodium.sodium_version_string(),
      local: { ...local, schemaVersion: 12, reopen: 'PASS', bank: bankPath },
      secrets: {
        result: 'PASS',
        checks,
        backend: safeStorage.getSelectedStorageBackend(),
        available: safeStorage.isEncryptionAvailable(),
      },
    };
    if (
      !process.argv[2] ||
      !resolve(process.argv[2]).startsWith(resolve(tmpdir()) + '/')
    )
      throw new Error('Report must be under /tmp.');
    writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({ ...report, sealedBox: 'public fixture omitted' }),
    );
    rmSync(isolated, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
