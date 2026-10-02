import { setSyncUuidProvider } from './syncWriters';
import { androidSyncUuidGenerator } from '../sync/crypto';
import { open, type NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { migrate, migrations } from './migrations';
import { syntheticBankOptIn } from '../sync/syntheticOptIn';
import { localFiles } from '../files/native';

// Fast Refresh can reload this module while the native connection stays open.
// Keep the initialization promise on the JS runtime, including concurrent callers.
const state = globalThis as typeof globalThis & {
  lionPocketDatabase?: Promise<NitroSQLiteConnection>;
};
export function database(): Promise<NitroSQLiteConnection> {
  if (!state.lionPocketDatabase) {
    state.lionPocketDatabase = (async () => {
      // A full JS reload may outlive the native default connection.
      const name = syntheticBankOptIn() ? 'lion-sync-dev-manual.sqlite' : 'lionpocket.sqlite';
      const db = open({ name, connection: 'independent' });
      try {
        await db.executeAsync('PRAGMA foreign_keys = ON');
        await migrate(db, async () => {
          const file = await localFiles.prepareFile('backups', 'sqlite');
          await db.executeAsync('VACUUM INTO ?', [file.path]);
        });
        setSyncUuidProvider(androidSyncUuidGenerator);
        // Emitted only after every migration transaction commits. No financial data or secrets.
        console.info(`[LionPocket] database ready: ${name} schema=${migrations.length}`);
        return db;
      } catch (error) {
        console.error(`[LionPocket] database initialization failed: ${name}`, error instanceof Error ? error.message : 'unknown error');
        db.close();
        throw error;
      }
    })().catch((error) => {
      state.lionPocketDatabase = undefined;
      throw error;
    });
  }
  return state.lionPocketDatabase;
}
