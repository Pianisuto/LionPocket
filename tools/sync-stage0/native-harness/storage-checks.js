// Disposable historical fixtures only; never opens lionpocket.sqlite.
import { open } from 'react-native-nitro-sqlite';
import { migrate, migrations } from './migrations';
const fixtures = require('./fixtures/databases.json');
export async function runStorageChecks() {
  let checks = 0;
  const same = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
    checks++;
  };
  const version = async (db) => (await db.executeAsync('PRAGMA user_version')).rows._array[0].user_version;
  const rows = async (db, table) => (await db.executeAsync(`SELECT ${table.columns.join(',')} FROM ${table.name}`)).rows._array
    .map((row) => table.columns.map((column) => row[column])).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const cases = [...fixtures, {...fixtures.find((f)=>f.version===4), version:5, prepareParity:true}];
  for (const fixture of cases) {
    const name = `stage0-fixture-v${fixture.version}-${Date.now()}.sqlite`;
    const db = open({ name, connection: 'independent' });
    let backup;
    try {
      for (const sql of fixture.statements) await db.executeAsync(sql);
      if(fixture.prepareParity) await db.transaction(async(tx)=>{
        for(const sql of migrations[4]) await tx.executeAsync(sql);
        await tx.executeAsync('PRAGMA user_version=5');
      });
      await db.executeAsync('PRAGMA journal_mode = WAL');
      for (const table of fixture.tables) same(await rows(db, table), table.rows, 'Original native rows');
      same(await version(db), fixture.version, 'Original version');
      let refused = false;
      try { await migrate(db, async () => { throw new Error('Injected backup failure'); }); } catch { refused = true; }
      same(refused, true, 'Failed backup must block migration');
      same(await version(db), fixture.version, 'Version preserved after backup failure');
      if (fixture.version === 4 || fixture.version === 5) {
        refused = false;
        const faulting = {
          executeAsync: db.executeAsync.bind(db),
          transaction: (action) => db.transaction((tx) => action({
            executeAsync: async (sql, args) => {
              const result = await tx.executeAsync(sql, args);
              if (sql === `PRAGMA user_version = ${fixture.version + 1}`) throw new Error('Injected late migration failure');
              return result;
            },
          })),
        };
        try { await migrate(faulting, async () => {}); } catch { refused = true; }
        same(refused, true, 'Late migration failure');
        same(await version(db), fixture.version, 'Late migration version rollback');
        if(fixture.version===5) same((await db.executeAsync("SELECT name FROM sqlite_master WHERE name LIKE 'sync_%'")).rows._array.length,0,'Real v6 DDL rollback');
        for (const table of fixture.tables) same(await rows(db, table), table.rows, 'Late migration row rollback');
      }
      let copies = 0;
      await migrate(db, async () => {
        const file = (await db.executeAsync('PRAGMA database_list')).rows._array.find((row) => row.name === 'main').file;
        await db.executeAsync('VACUUM INTO ?', [file + '.pre-spike.sqlite']); copies++;
      });
      same(copies, 1, 'One pre-migration copy');
      backup = open({ name: name + '.pre-spike.sqlite', connection: 'independent', readOnly: true });
      same(await version(backup), fixture.version, 'Backup version');
      same(await version(db), migrations.length, 'Native migrated version');
      for (const table of fixture.tables) {
        same(await rows(db, table), table.rows, 'Every legacy column after native migration');
        same(await rows(backup, table), table.rows, 'Every legacy column in WAL-aware backup');
      }
      same((await db.executeAsync('PRAGMA foreign_key_check')).rows._array.length, 0, 'Native FK integrity');
      same((await db.executeAsync('PRAGMA integrity_check')).rows._array[0].integrity_check, 'ok', 'Native integrity');
      // A future sidecar must roll back together with the local write.
      try {
        await db.transaction(async (tx) => {
          await tx.executeAsync('CREATE TABLE sync_spike_identity (local_id TEXT PRIMARY KEY, global_id TEXT UNIQUE)');
          await tx.executeAsync("UPDATE transactions SET description = 'Injected sidecar failure'");
          await tx.executeAsync("INSERT INTO sync_spike_identity VALUES ('legacy', 'test')");
          throw new Error('Injected sidecar failure');
        });
      } catch (error) { if (!String(error).includes('Injected sidecar failure')) throw error; }
      same((await db.executeAsync("SELECT name FROM sqlite_master WHERE name = 'sync_spike_identity'")).rows._array.length, 0, 'Additive DDL rollback');
      for (const table of fixture.tables) same(await rows(db, table), table.rows, 'Additive writer rollback');
    } finally {
      if (backup) backup.close();
      db.delete(); // Only the randomly named disposable main file; backup remains in disposable app storage.
    }
  }
  const probe = open({ name: 'stage0-version-probe.sqlite', connection: 'independent' });
  try {
    return { result: 'PASS', checks, driver: 'react-native-nitro-sqlite 10.0.0', sqlite: (await probe.executeAsync('SELECT sqlite_version() AS version')).rows._array[0].version,
      schemas: cases.map((fixture) => `${fixture.version}→${migrations.length}`), syntheticFixturesOnly: true };
  } finally { probe.delete(); }
}
