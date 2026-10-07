import { createEpochAnchorBackup, inspectEpochAnchorBackup, inspectEpochActivationCheckpoint } from './epochBackup';
import { savePublicProfile } from './publicProfile';
import { desktopForeground } from './foreground';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  SyncController,
  assertServerResetIntent,
  type SyncSaved,
  type SyncStatus,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
import { DesktopSecretStore } from './secretStore';
import { desktopCrypto } from './crypto';
import { loginOidc } from './oidc';
export const privateBeta = (typeof LIONPOCKET_BUILD_CHANNEL !== 'undefined' && LIONPOCKET_BUILD_CHANNEL === 'private-beta') || process.argv.includes('--private-beta');
export async function registerSyncController(bank: LionPocketDatabase) {
  let controller: Promise<SyncController> | undefined;
  const get = async () => {
    if (controller) return controller;
    controller = (async () => {
      const directory = join(app.getPath('userData'), 'sync');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const profilePath = join(directory, 'public-profile.json');
      const beta = new SyncController({
        db: bank.syncDatabase(),
        secrets: new DesktopSecretStore(join(directory, 'secret-wrappers')),
        sodium: await desktopCrypto(),
        dialect: 'desktop',
        deviceName: hostname().slice(0,80),
        defaultEndpoint: privateBeta && typeof LIONPOCKET_BETA_ENDPOINT !== 'undefined' ? LIONPOCKET_BETA_ENDPOINT : '',
        storage: {
          load: async () => {
            try {
              return JSON.parse(
                await readFile(profilePath, 'utf8'),
              ) as SyncSaved;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw e;
            }
          },
          save: (value) => savePublicProfile(profilePath, value),
        },
        epochBackup: {
          create: () => createEpochAnchorBackup(bank.db, join(directory, `recovery-${randomUUID()}.sqlite`)),
          inspect: inspectEpochAnchorBackup,
          inspectCheckpoint: inspectEpochActivationCheckpoint,
        },
        backup: async () => {
          const target = join(directory, `pre-binding-${randomUUID()}.sqlite`);
          bank.db.prepare('VACUUM INTO ?').run(target);
          return target;
        },
        login: async (e) =>
          loginOidc({
            issuer: e.oidc.issuer,
            clientId: e.oidc.desktopClientId,
            redirectUri: e.oidc.desktopRedirect,
          }, (url) => shell.openExternal(url)),
      });
      await beta.resumeRecoveryOnStartup().catch(() => {
        /* An incomplete saga blocks foreground eligibility. Local use and explicit finalization remain available. */
      });
      const removeWrite = bank.onLocalSyncWrite(() =>
        beta.localWriteCommitted(),
      );
      const removeStatus = beta.subscribe(() => {
        for (const window of BrowserWindow.getAllWindows())
          if (!window.isDestroyed())
            window.webContents.send('sync:changed');
      });
      const removeForeground = desktopForeground(
        app,
        () => !!BrowserWindow.getFocusedWindow(),
        (active) => beta.setForeground(active),
      );
      app.once('before-quit', () => {
        removeWrite();
        removeStatus();
        removeForeground();
        beta.coordinator.dispose();
      });
      return beta;
    })().catch((error) => {
      controller = undefined;
      throw error;
    });
    return controller;
  };
  // Initialize before window creation; focus events then drive startup/return.
  await get().catch(() => {
      /* Sync setup must not prevent opening the local bank. */
    });
  ipcMain.handle('sync:status', async () =>
    (await get()).status(),
  );
  ipcMain.handle(
    'sync:command',
    async (_event, action: string, args: unknown[]) => {
      if (!Array.isArray(args) || args.length > 5)
        throw new Error('Invalid sync action.');
      const c = await get();
      switch (action) {
        case 'unlink':
          return c.unlinkServer(args[0] === true);
        case 'server-reset':
          assertServerResetIntent(args[1]);
          return c.resetForRecreatedServer(String(args[0]),args[1],args[2] === true);
        case 'server-recovery-prepare':
          return c.prepareServerRecovery(args[0] === true);
        case 'server-recovery-confirm':
          return c.confirmServerRecovery(String(args[0]));
        case 'server-recovery-activate':
          return c.activateServerRecovery(args[0] === true);
        case 'reconnect':
          return c.reconnectRestored(args[0] === true);
        case 'delete-review':
          return c.confirmLegacyDeletion(String(args[0]), args[1] === true);
        case 'rotate':
          return c.rotateKeys();
        case 'revoke':
          return c.revoke(String(args[0]), String(args[1]));
        case 'recovery-generate':
          return c.generateRecovery();
        case 'recovery-confirm':
          return c.confirmRecovery(String(args[0]));
        case 'recover':
          return c.recover(String(args[0]), String(args[1]));
        case 'invite-create': return c.createInvitation();
        case 'invite-revoke': return c.cancelInvitation();
        case 'pairing-inspect': return c.inspectPairingInvitation(String(args[0]));
        case 'pairing-connect': return c.connectInvitation(String(args[0]));
        case 'pairing-deny': return c.deny(String(args[0]));
        case 'setup': await c.configure(String(args[0])); return c.create();
        case 'configure':
          return c.configure(String(args[0]));
        case 'create':
          return c.create();
        case 'sync':
          return c.sync();
        case 'approve':
          return c.approve(String(args[0]));
        case 'pause':
          return c.pause(args[0] === true);
        case 'resolve':
          return c.resolve(
            String(args[0]),
            args[1] as string[],
            String(args[2]),
            args[3] === true,
          );
        default:
          throw new Error('Invalid sync action.');
      }
    },
  );
  return { inspectPairingLink: async (link: string) => (await get()).inspectPairingInvitation(link) };
}
export type DesktopSyncStatus = SyncStatus;
