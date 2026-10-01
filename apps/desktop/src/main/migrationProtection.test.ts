import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LionPocketDatabase } from './database';
import { syncTables } from '@lionpocket/sync-local';
import { initializeLocalSchema } from './migrationProtection';
import { captureDatabaseManifest, projectLegacyColumns } from '../../../../tools/sync-stage0/database-manifest.cjs';

import { rehearseCatalogRebuild } from '../../../../tools/sync-stage0/catalog-rebuild.cjs';

const directories: string[] = [], connections: DatabaseSync[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function legacy() {
  const directory = mkdtempSync(join(tmpdir(), 'lion-stage0-'));
  directories.push(directory);
  const path = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  connections.push(db);
  db.exec(readFileSync(join(process.cwd(), '../../docs/fixtures/local-first/desktop-v10.sql'), 'utf8'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  return { directory, path, db };
}
function recovery(directory: string) {
  const file = readdirSync(directory).find((name) => name.includes('.pre-migration-'));
  expect(file).toBeDefined();
  if (!file) throw new Error('Recovery fixture missing.');
  const db = new DatabaseSync(join(directory, file));
  connections.push(db);
  return db;
}
describe('proteção de migrations desktop', () => {
  it('protege WAL antes de atualizar v10; conserva todas as colunas antigas e reabre sem outra cópia', () => {
    const { path, db, directory } = legacy();
    db.prepare("UPDATE transactions SET notes=? WHERE id='legacy-manual'").run('Última escrita confirmada no WAL');
    const before = captureDatabaseManifest(db);
    const database = new LionPocketDatabase(path);
    connections.push(database.db);
    expect(captureDatabaseManifest(recovery(directory))).toEqual(before);
    const financial = { ...before, tables: before.tables.filter((t) => t.name !== 'migrations') };
    expect(projectLegacyColumns(database.db, financial)).toEqual(financial.tables.map(({ name, columns, rows }) => ({ name, columns, rows })));
    expect(database.db.prepare('SELECT pinned_from_month FROM recurring_transaction_priorities').get()).toMatchObject({ pinned_from_month: '0000-01' });
    expect(database.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.db.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    const after = captureDatabaseManifest(database.db);
    const reopened = new LionPocketDatabase(path);
    connections.push(reopened.db);
    expect(captureDatabaseManifest(reopened.db)).toEqual(after);
    expect(readdirSync(directory).filter((name) => name.includes('.pre-migration-'))).toHaveLength(1);
    reopened.saveTransaction({ kind: 'expense', description: 'Local sem conta', plannedAmount: 0, actualAmount: 0, dueDate: '2026-09-30', status: 'paid', settledDate: '2026-09-30' });
    expect(reopened.listTransactions({ month: '2026-09' }).some((t) => t.description === 'Local sem conta' && t.actualAmount === 0)).toBe(true);
  });
  it('v11 → v12 is additive and does not replay financial corrections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-stage1-v11-')); directories.push(directory);
    const path = join(directory,'synthetic-v11.sqlite');
    const initial = new LionPocketDatabase(path); connections.push(initial.db);
    const input = {kind:'expense' as const,description:'Preserve every old byte',plannedAmount:0,dueDate:'2026-09-30',status:'planned' as const};
    initial.saveTransaction(input);
    initial.saveRecurringExpense({kind:'expense',description:'Historical audit',active:true,startMonth:'2026-09',plannedAmount:0,dueDay:30});
    initial.db.exec("UPDATE recurring_expenses SET start_month='legacy literal'; DELETE FROM migrations WHERE version=12");
    for(const table of [...syncTables].reverse()) initial.db.exec(`DROP TABLE ${table}`);
    const before=captureDatabaseManifest(initial.db);
    const migrated=new LionPocketDatabase(path);connections.push(migrated.db);
    const financial = {...before,tables:before.tables.filter((t)=>t.name!=='migrations')};
    expect(projectLegacyColumns(migrated.db,financial)).toEqual(financial.tables.map(({name,columns,rows})=>({name,columns,rows})));
    expect(captureDatabaseManifest(recovery(directory))).toEqual(before);
    expect(migrated.db.prepare('SELECT mode,local_scope_id FROM sync_local_state').get()).toMatchObject({mode:'disabled',local_scope_id:null});
  });
  it('falha tardia na migration real v12 reverte sidecars e preserva a base v11', () => {
    const directory=mkdtempSync(join(tmpdir(),'lion-stage1-ddl-'));directories.push(directory);
    const path=join(directory,'synthetic-v11.sqlite'),initial=new LionPocketDatabase(path);connections.push(initial.db);
    initial.saveTransaction({kind:'expense',description:'Preservar',plannedAmount:0,dueDate:'2026-09-30',status:'planned'});
    initial.db.exec('DELETE FROM migrations WHERE version=12');
    for(const table of [...syncTables].reverse())initial.db.exec(`DROP TABLE ${table}`);
    initial.db.exec('CREATE TABLE sync_inbox(blocked TEXT)'); // Failure at the last additive DDL.
    const before=captureDatabaseManifest(initial.db);
    expect(()=>new LionPocketDatabase(path)).toThrow('already exists');
    expect(captureDatabaseManifest(initial.db)).toEqual(before);
    expect(captureDatabaseManifest(recovery(directory))).toEqual(before);
  });
  it('reverte DDL e escrita tardia; a cópia conserva a versão anterior', () => {
    const { path, db, directory } = legacy(), before = captureDatabaseManifest(db);
    expect(() => initializeLocalSchema(db, path, () => {
      db.exec("ALTER TABLE categories ADD COLUMN preparation TEXT; UPDATE transactions SET notes='não deve persistir'; CREATE TABLE preparation(id TEXT)");
      throw new Error('Falha tardia');
    })).toThrow('Falha tardia');
    expect(captureDatabaseManifest(db)).toEqual(before);
    expect(captureDatabaseManifest(recovery(directory))).toEqual(before);
  });
  it('aborta antes da migration quando não consegue gravar a recuperação', () => {
    const { db, directory } = legacy(), before = captureDatabaseManifest(db);
    let called = false;
    expect(() => initializeLocalSchema(db, join(directory, 'inexistente/db'), () => { called = true; })).toThrow('proteger');
    expect(called).toBe(false);
    expect(captureDatabaseManifest(db)).toEqual(before);
  });
  it('rejeita versão futura sem tocar registros, índices ou marcadores', () => {
    const { path, db, directory } = legacy();
    db.exec("INSERT INTO migrations VALUES(99,'futuro')");
    const before = captureDatabaseManifest(db);
    expect(() => new LionPocketDatabase(path)).toThrow('mais nova');
    expect(captureDatabaseManifest(db)).toEqual(before);
    expect(readdirSync(directory).some((name) => name.includes('.pre-migration-'))).toBe(false);
  });
  it('refuses a future database before switching DELETE journal to WAL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-future-release-')); directories.push(directory);
    const path = join(directory, 'future.sqlite'), db = new DatabaseSync(path); connections.push(db);
    db.exec("CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO migrations VALUES(99,'future'); PRAGMA journal_mode=DELETE");
    const before = captureDatabaseManifest(db);
    expect(() => new LionPocketDatabase(path)).toThrow('mais nova');
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    expect(captureDatabaseManifest(db)).toEqual(before);
    expect(readdirSync(directory)).toEqual(['future.sqlite']);
  });
  it('ensaia rebuild de cadastros com unicidade parcial, FKs ligadas e rollback tardio', () => {
    const { db: sqlite } = legacy();
    const before = captureDatabaseManifest(sqlite);
    expect(() => rehearseCatalogRebuild(sqlite, true)).toThrow('Injected late');
    expect(captureDatabaseManifest(sqlite)).toEqual(before);
    rehearseCatalogRebuild(sqlite);
    expect(projectLegacyColumns(sqlite, before)).toEqual(before.tables.map(({ name, columns, rows }) => ({ name, columns, rows })));
    expect(sqlite.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(sqlite.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    expect(() => sqlite.exec("INSERT INTO payment_methods(id,name,created_at,updated_at) VALUES('collision','Pagamento próprio','test','test')")).toThrow();
    sqlite.exec("UPDATE payment_methods SET deleted_at='2026-09-30' WHERE id='legacy-payment'; INSERT INTO payment_methods(id,name,created_at,updated_at) VALUES('replacement','Pagamento próprio','test','test')");
    expect(sqlite.prepare('SELECT count(*) AS count FROM payment_methods').get()).toMatchObject({ count: 2 });
    expect(sqlite.prepare("SELECT payment_method_id FROM transactions WHERE id='legacy-manual'").get()).toMatchObject({ payment_method_id: 'legacy-payment' });
  });

});
