import { open, type NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { migrate } from './migrations';
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
      const db = open({ name: 'lionpocket.sqlite', connection: 'independent' });
      try {
        await db.executeAsync('PRAGMA foreign_keys = ON');
        await migrate(db, async () => {
          const file = await localFiles.prepareFile('backups', 'sqlite');
          await db.executeAsync('VACUUM INTO ?', [file.path]);
        });
        return db;
      } catch (error) {
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
