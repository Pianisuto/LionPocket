import { app, ipcMain, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  bindSynthetic,
  DevelopmentSyncActions,
  ManualSync,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
import { desktopProvisioning } from './provisioning';
import { desktopCrypto } from './crypto';
import { loginDevelopmentOidc } from './oidc';
export function desktopSyntheticDirectory(): string | null {
  if (
    app.isPackaged ||
    process.env.LIONPOCKET_SYNC_DEV !== 'synthetic-only' ||
    process.env.LIONPOCKET_SYNC_MANUAL !== 'synthetic-only'
  )
    return null;
  const directory = resolve(process.env.LIONPOCKET_SYNC_PROFILE ?? '');
  if (!/^\/tmp\/lion-sync-dev-[a-zA-Z0-9_-]+$/.test(directory))
    throw new Error('Separate synthetic profile required.');
  return directory;
}
export async function registerDevelopmentSync(
  bank: LionPocketDatabase,
  directory: string | null,
) {
  let actions: DevelopmentSyncActions | undefined;
  const setup = async () => {
    if (!directory) throw new Error('sync_disabled');
    if (actions) return actions;
    const saved = JSON.parse(
      await readFile(join(directory, 'public-profile.json'), 'utf8'),
    ) as {
      synthetic: boolean;
      identity: { issuer: string; subject: string };
      profile: ProvisionedProfile;
    };
    if (saved.synthetic !== true) throw new Error('synthetic_profile_required');
    const device = await desktopProvisioning(
      saved.profile,
      join(directory, 'secret-wrappers'),
    );
    const [state] = await bank
      .syncDatabase()
      .read('SELECT * FROM sync_local_state WHERE id=1');
    if (state.local_scope_id === null) bank.enableSyntheticManualSyncPilot();
    if (state.binding_id === null)
      await bank
        .syncDatabase()
        .run(
          bindSynthetic(saved.profile, 'http://127.0.0.1:8787', randomUUID()),
        );
    else {
      const [b] = await bank
        .syncDatabase()
        .read(
          'SELECT registry_json,checkpoint_json FROM sync_bindings WHERE binding_id=?',
          [String(state.binding_id)],
        );
      device.profile.grants = JSON.parse(String(b.registry_json));
      device.profile.checkpoint = JSON.parse(String(b.checkpoint_json));
    }
    actions = new DevelopmentSyncActions(
      new ManualSync(
        bank.syncDatabase(),
        device,
        await desktopCrypto(),
        'desktop',
        'http://127.0.0.1:8787',
      ),
    );
    return actions;
  };
  if (directory) await setup();
  ipcMain.handle('sync:development:status', async () =>
    directory ? (await setup()).status() : null,
  );
  ipcMain.handle('sync:development:run', async () => {
    const a = await setup(),
      saved = JSON.parse(
        await readFile(join(directory!, 'public-profile.json'), 'utf8'),
      ) as { identity: { issuer: string; subject: string } };
    const session = await loginDevelopmentOidc(
      'lionpocket-desktop-dev',
      (url) => shell.openExternal(url),
    );
    if (
      session.issuer !== saved.identity.issuer ||
      session.subject !== saved.identity.subject
    )
      throw new Error('identity_mismatch');
    await a.engine.sync(session.accessToken);
    return a.status();
  });
  ipcMain.handle(
    'sync:development:resolve',
    async (
      _event,
      objectId: string,
      heads: string[],
      revisionId: string,
      recover: boolean,
    ) => (await setup()).resolve(objectId, heads, revisionId, recover),
  );
}
