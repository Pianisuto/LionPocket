// Disposable synthetic databases only. No source of personal files or secrets.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { migrations, migrate } from '../../apps/mobile/src/db/migrations';
import { sqliteTestConnection } from '../../apps/mobile/src/db/sqliteTestConnection';
import { MobileRepository } from '../../apps/mobile/src/db/repository';
import { mobileSyncDatabase } from '../../apps/mobile/src/sync/database';
import { bindSynthetic, ManualSync, ProvisioningCrypto, receivePage } from '@lionpocket/sync-local';
import { founder } from '../../apps/sync-server/src/testSupport';
import { captureDatabaseManifest } from '../sync-stage0/database-manifest.cjs';

async function main() {
  const directory = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || relative(tmpdir(), directory).includes(sep) || !/^lion-release-fixtures-/.test(relative(tmpdir(), directory))) throw new Error('Disposable fixture directory required.');
  if (existsSync(directory) && (realpathSync(directory) !== directory || readdirSync(directory).length)) throw new Error('Fresh empty disposable fixture directory required.');
  mkdirSync(directory, { recursive: true });
  for (const version of [1, 4, 5, 8]) {
    const { db, sqlite } = sqliteTestConnection(join(directory, `v${version}.sqlite`));
    try {
      if (version < 8) {
        sqlite.exec(readFileSync(resolve(__dirname, `../../docs/fixtures/local-first/mobile-v${Math.min(version, 4)}.sql`), 'utf8'));
        if (version === 5) {
          for (const statement of migrations[4]) sqlite.exec(statement);
          sqlite.exec('PRAGMA user_version=5');
          sqlite.exec("INSERT INTO local_preferences VALUES('release-fixture','zero/null/Unicode 🍋')");
        }
        // Avoid time-dependent creation of new projection-cache rows when product UI opens.
        if (version >= 4) sqlite.exec('UPDATE recurring_expenses SET active=0');
      } else {
        await migrate(db);
        await sodium.ready;
        const repo = new MobileRepository(db, randomUUID), adapter = mobileSyncDatabase(db);
        await repo.enableSyntheticManualSyncPilot();
        const { client } = await founder(new ProvisioningCrypto(sodium));
        await adapter.run(bindSynthetic(client.profile, 'https://fixture.invalid', randomUUID()));
        await repo.save({ kind: 'expense', description: 'Fixture zero/null 🍋', plannedAmount: 0, actualAmount: null, dueDate: '2026-08-12', status: 'planned' });
        await repo.save({ kind: 'expense', description: 'Fixture tombstone', plannedAmount: 12.34, actualAmount: 0, dueDate: '2026-08-12', status: 'paid', settledDate: '2026-08-12' });
        const [deleted] = await adapter.read("SELECT id FROM transactions WHERE description='Fixture tombstone'");
        await repo.remove(String(deleted.id));
        const [pending] = await adapter.read('SELECT commit_id FROM sync_outbox ORDER BY local_seq LIMIT 1');
        const engine = new ManualSync(adapter, client, sodium, 'android', 'https://fixture.invalid');
        const envelope = JSON.parse(await engine.prepare(String(pending.commit_id)));
        const [state] = await adapter.read('SELECT * FROM sync_local_state');
        await adapter.run(receivePage(String(state.binding_id), '0', '1', '1', [{ envelope, logPosition: '1', acceptedRegistryVersion: '1' }], false));
        sqlite.exec("UPDATE sync_local_state SET mode='disabled'; INSERT INTO local_preferences VALUES('release-fixture','zero/null/Unicode 🍋')");
      }
      const manifest = captureDatabaseManifest(sqlite);
      writeFileSync(join(directory, `v${version}.json`), JSON.stringify(manifest, null, 2));
      if (sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Bad fixture.');
    } finally { sqlite.close(); }
  }
  console.log(JSON.stringify({ directory, versions: [1, 4, 5, 8], syntheticOnly: true }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
