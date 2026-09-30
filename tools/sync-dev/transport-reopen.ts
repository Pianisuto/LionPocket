import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LionPocketDatabase } from '../../apps/desktop/src/main/database';
import { desktopProvisioning } from '../../apps/desktop/src/main/sync/provisioning';
import { desktopCrypto } from '../../apps/desktop/src/main/sync/crypto';
import { ManualSync, type ProvisionedProfile } from '@lionpocket/sync-local';
const directory = resolve(process.argv[2] ?? '');
if (!/^\/tmp\/lion-sync-dev-native-[a-zA-Z0-9]+$/.test(directory))
  throw new Error('Synthetic crash profile required');
app.setPath('userData', join(directory, 'electron'));
app
  .whenReady()
  .then(async () => {
    const profile = JSON.parse(
      readFileSync(join(directory, 'crash-public-profile.json'), 'utf8'),
    ) as ProvisionedProfile;
    const device = await desktopProvisioning(
      profile,
      join(directory, 'secret-wrappers'),
    );
    // Verify actual system cofre access in a separate Electron process.
    const seed = await device.secrets.load(device.scope('signingSeed')),
      key = await device.secrets.load(device.scope('dataKey'));
    if (!seed || !key) throw new Error('Cofre reopen failed');
    const pair = (await desktopCrypto()).crypto_sign_seed_keypair(seed);
    const publicKey = device.crypto.encode(pair.publicKey);
    device.crypto.erase(pair.privateKey);
    device.crypto.erase(seed);
    device.crypto.erase(key);
    if (publicKey !== profile.signingPublicKey)
      throw new Error('Signing identity changed');
    const bank = new LionPocketDatabase(join(directory, 'manual.sqlite'));
    bank.saveTransaction({
      kind: 'expense',
      description: 'SYNTHETIC Electron crash WAL',
      plannedAmount: 0,
      dueDate: '2026-09-30',
      status: 'planned',
    });
    const [row] = await bank
      .syncDatabase()
      .read(
        "SELECT commit_id FROM sync_outbox WHERE state='pending' ORDER BY length(local_seq) DESC,local_seq DESC LIMIT 1",
      );
    const engine = new ManualSync(
      bank.syncDatabase(),
      device,
      await desktopCrypto(),
      'desktop',
      'http://127.0.0.1:18774',
    );
    await engine.prepare(String(row.commit_id));
    process.kill(process.pid, 'SIGKILL'); // Deliberately leave the committed WAL and cofre wrappers open.
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
