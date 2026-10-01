// Explicit disposable CI mode; never selects an existing user profile.
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { savePublicProfile } from './sync/publicProfile';
import { DesktopSecretStore } from './sync/secretStore';
import { LionPocketDatabase } from './database';

export function releaseSmokeDirectory(): string | null {
  const argument = process.argv.find(arg => arg.startsWith('--release-smoke='));
  if (!argument) return null;
  const directory = argument.slice('--release-smoke='.length);
  const child = relative(tmpdir(), directory);
  if (!isAbsolute(directory) || child.includes(sep) || !/^lion-release-smoke-[a-zA-Z0-9_-]+$/.test(child) || resolve(directory) !== directory)
    throw new Error('Disposable release smoke directory required.');
  return directory;
}
export async function verifyReleaseSmoke(bank: LionPocketDatabase, directory: string, beta: boolean, updateFeed: string | null): Promise<void> {
  const before = JSON.parse(readFileSync(join(directory, 'before.json'), 'utf8')) as { tables: {name: string; columns: string[]; rows: unknown[]}[] };
  for (const table of before.tables.filter(t => t.name !== 'migrations')) {
    if (!/^[a-z_]+$/.test(table.name) || table.columns.some(c => !/^[a-z_]+$/.test(c))) throw new Error('Invalid fixture identifiers.');
    const rows = bank.db.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name}`).all();
    const sort = (values: unknown[]) => values.map(v => JSON.stringify(v)).sort();
    if (JSON.stringify(sort(rows)) !== JSON.stringify(sort(table.rows))) throw new Error('Legacy rows changed.');
  }
  if (bank.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || bank.db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('Invalid upgraded fixture.');
  const profile = join(directory, beta ? 'LionPocket Beta' : 'LionPocket');
  if (app.getPath('userData') !== profile) throw new Error('Wrong channel profile.');
  const metadata = join(profile, 'smoke-public-profile.json');
  await savePublicProfile(metadata, { endpoint: 'https://fixture.invalid' });
  await savePublicProfile(metadata, { endpoint: 'https://fixture-updated.invalid' });
  if (JSON.parse(readFileSync(metadata, 'utf8')).endpoint !== 'https://fixture-updated.invalid') throw new Error('Public profile persistence failed.');
  const store = new DesktopSecretStore(join(profile, 'sync', 'smoke-wrappers'));
  const scope = { installationId: randomUUID(), deviceId: randomUUID(), serverId: randomUUID(), serverEpoch: randomUUID(), vaultId: randomUUID(), purpose: 'dataKey' as const, keyVersion: 1 };
  const secret = randomBytes(32);
  let vault: string;
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    try { await store.store(scope, secret); throw new Error('Insecure vault accepted.'); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'System secret vault unavailable.') throw error; }
    vault = 'basic_text refused';
  } else {
    await store.store(scope, secret);
    const loaded = await new DesktopSecretStore(join(profile, 'sync', 'smoke-wrappers')).load(scope);
    if (!loaded || !Buffer.from(loaded).equals(secret)) throw new Error('OS vault roundtrip failed.');
    loaded.fill(0); await store.remove(scope); vault = 'OS vault roundtrip passed';
  }
  secret.fill(0);
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ platform: process.platform, beta, profile: beta ? 'LionPocket Beta' : 'LionPocket', version: app.getVersion(), legacyTables: before.tables.length - 1, integrity: 'ok', foreignKeys: 0, vault, publicProfilePersistence: true, updateFeed, windowLoaded: true }, null, 2));
  bank.db.close();
  app.quit();
}
