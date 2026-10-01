import { desktopForeground } from './foreground';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BetaSync,
  type BetaSaved,
  type BetaStatus,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../database';
import { DesktopSecretStore } from './secretStore';
import { desktopCrypto } from './crypto';
import { loginDevelopmentOidc } from './oidc';
export const privateBeta = process.argv.includes('--private-beta');
export async function registerBetaSync(bank: LionPocketDatabase) {
  let controller: Promise<BetaSync> | undefined;
  const get = async () => {
    if (!privateBeta) throw new Error('Abra o perfil LionPocket Beta.');
    if (controller) return controller;
    controller = (async () => {
      const directory = join(app.getPath('userData'), 'sync');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const profilePath = join(directory, 'public-profile.json');
      const beta = new BetaSync({
        db: bank.syncDatabase(),
        secrets: new DesktopSecretStore(join(directory, 'secret-wrappers')),
        sodium: await desktopCrypto(),
        dialect: 'desktop',
        storage: {
          load: async () => {
            try {
              return JSON.parse(
                await readFile(profilePath, 'utf8'),
              ) as BetaSaved;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw e;
            }
          },
          save: async (value) => {
            const temporary = profilePath + '.' + randomUUID();
            const handle = await open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(JSON.stringify(value));
              await handle.sync();
            } finally {
              await handle.close();
            }
            await rename(temporary, profilePath);
            const parent = await open(directory, 'r');
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
          },
        },
        backup: async () => {
          const target = join(directory, `pre-binding-${randomUUID()}.sqlite`);
          bank.db.prepare('VACUUM INTO ?').run(target);
          return target;
        },
        login: async (e) =>
          loginDevelopmentOidc(
            'lionpocket-desktop-dev',
            (url) => shell.openExternal(url),
            180000,
            {
              issuer: e.oidc.issuer,
              clientId: e.oidc.desktopClientId,
              redirectUri: e.oidc.desktopRedirect,
            },
          ),
      });
      const removeWrite = bank.onLocalSyncWrite(() =>
        beta.localWriteCommitted(),
      );
      const removeStatus = beta.subscribe(() => {
        for (const window of BrowserWindow.getAllWindows())
          if (!window.isDestroyed())
            window.webContents.send('sync:beta:changed');
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
  if (privateBeta)
    await get().catch(() => {
      /* Sync setup must not prevent opening the local bank. */
    });
  ipcMain.handle('sync:beta:status', async () =>
    privateBeta ? (await get()).status() : null,
  );
  ipcMain.handle(
    'sync:beta:command',
    async (_event, action: string, args: unknown[]) => {
      if (!Array.isArray(args) || args.length > 5)
        throw new Error('Invalid sync action.');
      const c = await get();
      switch (action) {
        case 'catalog-batch':
          return c.preserveCatalogBatch(String(args[0]), args[1] === true);
        case 'reconnect':
          return c.reconnectRestored(args[0] === true);
        case 'series-reviews':
          return c.seriesReviews();
        case 'series-review':
          return c.reviewSeries(
            args[0] as 'recurring' | 'installmentPurchase',
            String(args[1]),
            args[2] as import('@lionpocket/sync-local').ReviewedSlot[],
          );
        case 'import-review':
          return c.reviewLegacyImport(String(args[0]), args[1] === true);
        case 'delete-review':
          return c.confirmLegacyDeletion(String(args[0]), args[1] === true);
        case 'catalog-reviews':
          return c.catalogReviews();
        case 'catalog-separate':
          return c.preserveBothCatalogs(
            String(args[0]),
            String(args[1]),
            String(args[2]),
          );
        case 'rotate':
          return c.rotateKeys();
        case 'revoke':
          return c.revoke(String(args[0]), String(args[1]));
        case 'recovery-generate':
          return c.generateRecovery();
        case 'recovery-confirm':
          return c.confirmRecovery(String(args[0]));
        case 'recover':
          return c.recover(String(args[0]), String(args[1]), String(args[2]));
        case 'configure':
          return c.configure(String(args[0]));
        case 'create':
          return c.create();
        case 'inspect':
          return c.inspectInvitation(String(args[0]));
        case 'pair':
          return c.pair(String(args[0]), String(args[1]));
        case 'receive':
          return c.receive();
        case 'sync':
          return c.sync();
        case 'requests':
          return c.requests();
        case 'approve':
          return c.approve(String(args[0]), String(args[1]));
        case 'pause':
          return c.pause(args[0] === true);
        case 'confirm':
          return c.confirmCombination();
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
}
export type DesktopBetaStatus = BetaStatus;
