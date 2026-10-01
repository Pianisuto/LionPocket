import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { migrations, migrate } from './migrations';
import { sqliteTestConnection } from './sqliteTestConnection';
import { captureBackup, loadBackupData, restoreBackup, verifyDatabase } from './backupRepository';
import { MobileRepository } from './repository';
import { captureDatabaseManifest, projectLegacyColumns } from '../../../../tools/sync-stage0/database-manifest.cjs';
import { rehearseCatalogRebuild } from '../../../../tools/sync-stage0/catalog-rebuild.cjs';

const connections: DatabaseSync[] = [], directories: string[] = [];
afterEach(() => {
  connections.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture(version: number) {
  const native = sqliteTestConnection(); connections.push(native.sqlite);
  native.sqlite.exec(readFileSync(join(process.cwd(), `../../docs/fixtures/local-first/mobile-v${version}.sql`), 'utf8'));
  return native;
}
function empty() { const native = sqliteTestConnection(); connections.push(native.sqlite); return native; }
describe('fixtures históricas e preparação aditiva mobile', () => {
  it.each([1, 2, 3, 4])('migra e restaura v%i conservando cada valor de cada coluna antiga', async (version) => {
    const { db, sqlite } = fixture(version), before = captureDatabaseManifest(sqlite);
    const protect = vi.fn(async () => {
      expect(captureDatabaseManifest(sqlite)).toEqual(before);
    });
    await migrate(db, protect);
    expect(protect).toHaveBeenCalledTimes(1);
    expect(projectLegacyColumns(sqlite, before)).toEqual(before.tables.map(({ name, columns, rows }) => ({ name, columns, rows })));
    await verifyDatabase(db, migrations.length);
    const current = await captureBackup(db), stage = empty();
    const hydrated = await loadBackupData(stage.db, current.data, current.schemaVersion);
    const target = empty(); await migrate(target.db);
    await restoreBackup(target.db, hydrated, async () => {});
    expect((await captureBackup(target.db)).data).toEqual(current.data);
    await migrate(db, protect);
    expect(protect).toHaveBeenCalledTimes(1);
  });
  it('rejects a future mobile schema before backup, DDL or any write', async () => {
    const { db, sqlite } = fixture(4);
    sqlite.exec('PRAGMA user_version=99');
    const before = captureDatabaseManifest(sqlite), protect = vi.fn(async () => {});
    await expect(migrate(db, protect)).rejects.toThrow('mais nova');
    expect(protect).not.toHaveBeenCalled();
    expect(captureDatabaseManifest(sqlite)).toEqual(before);
    expect(sqlite.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('reopens an already migrated v8 with preferences, sidecars and queues byte-for-byte', async () => {
    const { db, sqlite } = fixture(4);
    await migrate(db);
    sqlite.exec("INSERT INTO local_preferences VALUES('release-fixture','zero/null preserved')");
    const before = captureDatabaseManifest(sqlite), protect = vi.fn(async () => {});
    await migrate(db, protect);
    expect(protect).not.toHaveBeenCalled();
    expect(captureDatabaseManifest(sqlite)).toEqual(before);
    await verifyDatabase(db, migrations.length);
  });
  it('v5 → v6 acrescenta somente sidecars, preservando domínio e backup anterior', async () => {
    const {db,sqlite} = fixture(4);
    await db.transaction(async(tx)=>{for(const sql of migrations[4]) await tx.executeAsync(sql);await tx.executeAsync('PRAGMA user_version=5');});
    const before=captureDatabaseManifest(sqlite);
    const originalTransaction=db.transaction.bind(db);
    db.transaction=(action)=>originalTransaction(async(tx)=>{
      const execute=tx.executeAsync.bind(tx);
      tx.executeAsync=(async(...args: Parameters<typeof tx.executeAsync>)=>{
        const result=await execute(...args);
        if(args[0]==='PRAGMA user_version = 6') throw new Error('Late real v6 failure');
        return result;
      }) as typeof tx.executeAsync;
      return action(tx);
    });
    await expect(migrate(db,async()=>{})).rejects.toThrow('Late real v6 failure');
    expect(captureDatabaseManifest(sqlite)).toEqual(before);
    db.transaction=originalTransaction;
    const protect=vi.fn(async()=>{expect(captureDatabaseManifest(sqlite)).toEqual(before);});
    await migrate(db,protect);
    expect(protect).toHaveBeenCalledTimes(1);
    expect(projectLegacyColumns(sqlite,before)).toEqual(before.tables.map(({name,columns,rows})=>({name,columns,rows})));
    await verifyDatabase(db,migrations.length);
    expect(sqlite.prepare('SELECT mode,local_scope_id FROM sync_local_state').get()).toMatchObject({mode:'disabled',local_scope_id:null});
  });
  it('protege também uma futura atualização da versão atual e inclui a última escrita em WAL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-mobile-stage0-')); directories.push(directory);
    const path = join(directory, 'live.sqlite'), native = sqliteTestConnection(path); connections.push(native.sqlite);
    await migrate(native.db);
    native.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    const repo = new MobileRepository(native.db);
    await repo.save({ kind: 'expense', description: 'Zero e null', plannedAmount: 0, actualAmount: null, dueDate: '2026-09-30', status: 'planned' });
    const before = captureDatabaseManifest(native.sqlite);
    // Test-only next migration after the current production schema.
    const mutable = migrations as string[][];
    mutable.push(['CREATE TABLE preparation_metadata(id TEXT PRIMARY KEY)']);
    try {
      const protect = vi.fn(async () => { await native.db.executeAsync('VACUUM INTO ?', [join(directory, 'recovery.sqlite')]); });
      await migrate(native.db, protect);
      expect(protect).toHaveBeenCalledTimes(1);
      const recovery = new DatabaseSync(join(directory, 'recovery.sqlite')); connections.push(recovery);
      expect(captureDatabaseManifest(recovery)).toEqual(before);
      expect(projectLegacyColumns(native.sqlite, before)).toEqual(before.tables.map(({ name, columns, rows }) => ({ name, columns, rows })));
      expect((await repo.list({ month: '2026-09' }))[0]).toMatchObject({ plannedAmount: 0, actualAmount: null });
    } finally { mutable.pop(); }
  });
  it('falha tardia numa migration aditiva reverte domínio, metadados e user_version', async () => {
    const { db, sqlite } = fixture(4); await migrate(db);
    const before = captureDatabaseManifest(sqlite), mutable = migrations as string[][];
    mutable.push(['CREATE TABLE preparation_metadata(id TEXT PRIMARY KEY)', "UPDATE transactions SET notes='não deve persistir'", 'SELECT missing_stage0_function()']);
    try {
      await expect(migrate(db, async () => {})).rejects.toThrow('missing_stage0_function');
      expect(captureDatabaseManifest(sqlite)).toEqual(before);
      await expect(migrate(db, async () => { throw new Error('Sem cópia'); })).rejects.toThrow('Sem cópia');
      expect(captureDatabaseManifest(sqlite)).toEqual(before);
    } finally { mutable.pop(); }
  });
  it('INSERT de cadastro aceita uma coluna aditiva com default sem alterar registros existentes', async () => {
    const { db, sqlite } = fixture(4); await migrate(db);
    sqlite.exec('ALTER TABLE categories ADD COLUMN preparation_metadata TEXT; ALTER TABLE cards ADD COLUMN preparation_metadata TEXT; ALTER TABLE payment_methods ADD COLUMN preparation_metadata TEXT');
    const before = captureDatabaseManifest(sqlite);
    const repo = new MobileRepository(db);
    await repo.createCatalog({ type: 'category', name: 'Nova', kind: 'expense' });
    await repo.createCatalog({ type: 'card', name: 'Novo cartão', dueDay: 10 });
    await repo.createCatalog({ type: 'paymentMethod', name: 'Novo pagamento' });
    for (const table of before.tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
      for (const row of table.rows) expect(rows).toContainEqual(row);
    }
  });
  it('ensaia rebuild de cadastros com unicidade parcial, FKs ligadas e rollback tardio', async () => {
    const { db, sqlite } = fixture(4); await migrate(db);
    const before = captureDatabaseManifest(sqlite);
    expect(() => rehearseCatalogRebuild(sqlite, true)).toThrow('Injected late');
    expect(captureDatabaseManifest(sqlite)).toEqual(before);
    rehearseCatalogRebuild(sqlite);
    expect(projectLegacyColumns(sqlite, before)).toEqual(before.tables.map(({ name, columns, rows }) => ({ name, columns, rows })));
    expect(sqlite.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(sqlite.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(() => sqlite.exec("INSERT INTO payment_methods(id,name) VALUES('collision','Pagamento próprio')")).toThrow();
    sqlite.exec("UPDATE payment_methods SET deleted_at='2026-09-30' WHERE id='legacy-payment'; INSERT INTO payment_methods(id,name) VALUES('replacement','Pagamento próprio')");
    expect(sqlite.prepare('SELECT count(*) AS count FROM payment_methods').get()).toMatchObject({ count: 2 });
    expect(sqlite.prepare("SELECT payment_method_id FROM transactions WHERE id='legacy-manual'").get()).toMatchObject({ payment_method_id: 'legacy-payment' });
  });

});
