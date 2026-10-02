import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import {
  authorizeEpochRecovery, authorizeEpochRecoveryWithCode, DeviceProvisioning, ProvisioningCrypto,
  SyncController, syncTables, type SyncSaved, type SyncSession, type SignedRecovery,
  prepareAnchorArchive, planAnchorBaseline,
} from '@lionpocket/sync-local';
import { canonicalStringify, epochRecoverySigningInput, type EpochRecoveryChallenge, type EpochRecoveryAuthorization } from '@lionpocket/sync-protocol';
import { LionPocketDatabase } from '../../desktop/src/main/database';
import { loginDevelopmentOidc } from '../../desktop/src/main/sync/oidc';
import { sqliteTestConnection } from '../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../mobile/src/db/migrations';
import { MobileRepository } from '../../mobile/src/db/repository';
import { mobileSyncDatabase } from '../../mobile/src/sync/database';
import { TestSecrets, syntheticBrowserLogin } from './testSupport';
import { controlSchema, commitSchema, bindingSchema } from './schema';
import { controlServer, initialize } from './server';
import { keycloakIdentity } from './identity';
import { generationArchiveKeys } from './generations';
import { createEpochAnchorBackup, inspectEpochAnchorBackup } from '../../desktop/src/main/sync/epochBackup';

describe.skipIf(process.env.LIONPOCKET_SYNC_INTEGRATION !== '1')('restore preparation with real SQLite adapters, PostgreSQL and OIDC', () => {
  const database = 'lion_epoch_' + randomUUID().replaceAll('-', '');
  const directory = mkdtempSync(join(tmpdir(), 'lion-epoch-fixture-'));
  const endpoint = 'http://127.0.0.1:18779', issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
  const crypto = new ProvisioningCrypto(sodium), secrets = new TestSecrets();
  let admin: pg.Pool, pool: pg.Pool, server: Server, environment: { serverId: string; serverEpoch: string };
  let bank: LionPocketDatabase, mobile: ReturnType<typeof sqliteTestConnection>, repo: MobileRepository;
  let owner: SyncController, secondary: SyncController, saved: SyncSaved | null = null, paired: SyncSaved | null = null;
  let session: SyncSession, other: SyncSession, code: string, restoreId: string, epochA: string;
  const canary = 'LP_EPOCH_PRIVATE_DESCRIPTION_729134';
  const tables = ['sync_vaults', 'sync_grants', 'sync_pairings', 'sync_deliveries', 'sync_http_nonces', 'sync_commits', 'sync_operations', 'sync_remote_heads', 'sync_remote_bindings'];
  const input = { kind: 'expense' as const, description: canary, plannedAmount: 12.34, dueDate: '2026-10-02', status: 'planned' as const };
  const ownerProfile = () => {
    if (!saved?.profile) throw new Error('fixture_owner_unavailable');
    return saved.profile;
  };
  const secondaryProfile = () => {
    if (!paired?.profile) throw new Error('fixture_secondary_unavailable');
    return paired.profile;
  };
  const device = () => new DeviceProvisioning(structuredClone(ownerProfile()), secrets, crypto);
  const oldVault = () => ownerProfile().pin.vaultId;
  const snapshotLocal = () => ({
    desktop: Object.fromEntries(syncTables.map(t => [t, bank.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])),
    android: Object.fromEntries(syncTables.map(t => [t, mobile.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()])),
  });
  async function request(action: string, value: unknown, token = session.accessToken, vaultId = oldVault()) {
    const res = await fetch(`${endpoint}/v1/vaults/${vaultId}/${action}`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: canonicalStringify(value) });
    return { status: res.status, body: await res.json() };
  }
  async function challenge() {
    return request('epoch-recovery-challenge', { fromEpoch: epochA, authorityPublicKey: ownerProfile().pin.authorityPublicKey });
  }
  async function grantSigned(challenge: EpochRecoveryChallenge, fields: Partial<EpochRecoveryAuthorization> = {}) {
    const authorization = await authorizeEpochRecovery(device(), challenge, true);
    const { signature, ...unsigned } = { ...authorization, ...fields }; void signature;
    const seed = await secrets.load(device().scope('authoritySeed'));
    if (!seed) throw new Error('fixture_authority_unavailable');
    try { return { ...unsigned, signature: crypto.sign(epochRecoverySigningInput(unsigned), seed) }; }
    finally { seed?.fill(0); }
  }
  const submission = (authorization: EpochRecoveryAuthorization) => ({ authorization, knownGrants: ownerProfile().grants });
  function startServer() {
    server = controlServer({ pool, crypto, environment, origin: endpoint, identity: keycloakIdentity(issuer), financialEnabled: true,
      oidc: { issuer, desktopClientId: 'lionpocket-desktop-dev', androidClientId: 'lionpocket-android-dev',
        desktopRedirect: 'http://127.0.0.1:18761/callback', androidRedirect: 'com.lionpocketmobile.syncdev:/callback' } });
    return new Promise<void>(resolve => server.listen(18779, '127.0.0.1', resolve));
  }
  beforeAll(async () => {
    await sodium.ready;
    admin = new pg.Pool({ connectionString: 'postgresql://liondev:liondev@127.0.0.1:55432/postgres' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = new pg.Pool({ connectionString: `postgresql://liondev:liondev@127.0.0.1:55432/${database}` });
    await pool.query(controlSchema + commitSchema + bindingSchema);
    environment = await initialize(pool); epochA = environment.serverEpoch;
    await startServer();
    session = await loginDevelopmentOidc('lionpocket-desktop-dev', url => syntheticBrowserLogin(url));
    other = await loginDevelopmentOidc('lionpocket-desktop-dev', url => syntheticBrowserLogin(url, 'mallory'));
    bank = new LionPocketDatabase(join(directory, 'desktop.sqlite'));
    mobile = sqliteTestConnection(join(directory, 'android.sqlite')); await migrate(mobile.db);
    bank.db.exec('DELETE FROM categories; DELETE FROM cards; DELETE FROM payment_methods;');
    mobile.sqlite.exec('DELETE FROM categories; DELETE FROM cards; DELETE FROM payment_methods;');
    repo = new MobileRepository(mobile.db, () => crypto.uuid());
    owner = new SyncController({ db: bank.syncDatabase(), secrets, sodium, dialect: 'desktop', allowLocalDevelopment: true,
      storage: { load: async () => structuredClone(saved), save: async s => { saved = structuredClone(s); } },
      backup: async () => { const path = join(directory, crypto.uuid()+'.sqlite'); bank.db.prepare('VACUUM INTO ?').run(path); return path; }, login: async () => session });
    secondary = new SyncController({ db: mobileSyncDatabase(mobile.db), secrets, sodium, dialect: 'android', allowLocalDevelopment: true,
      storage: { load: async () => structuredClone(paired), save: async s => { paired = structuredClone(s); } },
      backup: async () => { const path = join(directory, crypto.uuid()+'.sqlite'); await mobile.db.executeAsync('VACUUM INTO ?', [path]); return path; }, login: async () => session });
    owner.setForeground(true); secondary.setForeground(true);
    await owner.configure(endpoint); await owner.create();
    code = (await owner.generateRecovery()).code; await owner.confirmRecovery(code);
    const first = await owner.status(), invite = await secondary.inspectInvitation(first.invitation);
    await secondary.pair(first.invitation, invite.fingerprint);
    const pairing = (await owner.requests()).requests[0]; await owner.approve(pairing.deviceId, pairing.fingerprint);
    await secondary.receive(); await secondary.sync(); await secondary.confirmCombination();
    bank.saveTransaction(input); await owner.sync(); await secondary.sync();
    owner.setForeground(false); secondary.setForeground(false);
    // PostgreSQL snapshot/restore in this isolated database; official pg_dump/lpctl is tested by clean-install.
    const snapshot = new Map<string, unknown>();
    for (const t of tables) snapshot.set(t, (await pool.query(`SELECT coalesce(jsonb_agg(t),'[]') AS rows FROM ${t} t`)).rows[0].rows);
    owner.setForeground(true);
    bank.saveTransaction({ ...input, description: 'DESKTOP_C2_AFTER_BACKUP' }); await owner.sync();
    await owner.revoke(secondaryProfile().deviceId, secondaryProfile().deviceId); owner.setForeground(false);
    await repo.save({ ...input, description: 'ANDROID_C3_OFFLINE' });
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      // A physical pg_restore recreates this schema too. The in-DB fixture clears its generation index before its vault rows.
      await tx.query('DELETE FROM sync_generations');
      for (const t of [...tables].reverse()) await tx.query(`DELETE FROM ${t}`);
      for (const t of tables) await tx.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(NULL::${t},$1::jsonb)`, [JSON.stringify(snapshot.get(t))]);
      restoreId = crypto.uuid(); environment.serverEpoch = crypto.uuid();
      await tx.query('INSERT INTO sync_restores(restore_id,server_id,from_epoch,to_epoch,displaced_epoch,backup_manifest_sha256) VALUES($1,$2,$3,$4,$3,$5)', [restoreId, environment.serverId, epochA, environment.serverEpoch, 'a'.repeat(64)]);
      await tx.query('INSERT INTO sync_restore_vaults(restore_id,vault_id,source_epoch) VALUES($1,$2,$3)', [restoreId, oldVault(), epochA]);
      await tx.query('UPDATE sync_environment SET server_epoch=$1', [environment.serverEpoch]); await tx.query('COMMIT');
    } finally { tx.release(); }
  }, 60000);
  afterAll(async () => {
    owner?.coordinator.dispose(); secondary?.coordinator.dispose(); bank?.db.close(); mobile?.sqlite.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    rmSync(directory, { recursive: true, force: true });
  });
  it('both adapters detect restore before transport, preserving C2/C3, revisions, immutable outbox and binding', async () => {
    const before = snapshotLocal();
    owner.setForeground(true); secondary.setForeground(true);
    await expect(owner.sync()).rejects.toThrow('epoch_changed'); await expect(secondary.sync()).rejects.toThrow('epoch_changed');
    owner.setForeground(false); secondary.setForeground(false);
    expect(snapshotLocal()).toEqual(before);
    expect(bank.listTransactions({ month: '2026-10' }).some(t => t.description === 'DESKTOP_C2_AFTER_BACKUP')).toBe(true);
    expect((await repo.list({ month: '2026-10' })).some(t => t.description === 'ANDROID_C3_OFFLINE')).toBe(true);
    expect((await pool.query('SELECT count(*) FROM sync_commits')).rows[0].count).toBe('1');
  });
  it('requires owner OIDC, exact vault/authority and a durable restore record, not equal serverId', async () => {
    const before = snapshotLocal();
    expect((await request('epoch-recovery-challenge', { fromEpoch: epochA, authorityPublicKey: ownerProfile().pin.authorityPublicKey }, other.accessToken)).status).toBe(403);
    expect((await request('epoch-recovery-challenge', { fromEpoch: epochA, authorityPublicKey: crypto.nonce() })).status).toBe(403);
    expect((await request('epoch-recovery-challenge', { fromEpoch: epochA, authorityPublicKey: ownerProfile().pin.authorityPublicKey }, session.accessToken, crypto.uuid())).status).toBe(403);
    const actual = environment.serverEpoch; environment.serverEpoch = crypto.uuid();
    expect((await challenge()).body.error).toBe('restore_record_required'); environment.serverEpoch = actual;
    expect(snapshotLocal()).toEqual(before);
  });
  it('existing authority and clean recovery code can sign; a paired device/login cannot, with zero local mutation', async () => {
    const before = snapshotLocal(), { body } = await challenge();
    const d = device();
    await expect(authorizeEpochRecovery(d, body.challenge, false)).rejects.toThrow('confirmation_required');
    await expect(authorizeEpochRecovery(new DeviceProvisioning(secondaryProfile(), secrets, crypto), body.challenge, true)).rejects.toThrow('authority_secret_unavailable');
    const clean = await DeviceProvisioning.prepare(body.pin, new TestSecrets(), crypto);
    expect(() => authorizeEpochRecoveryWithCode(clean, sodium, body.challenge, body.grants, body.recovery as SignedRecovery, 'LP1.' + crypto.nonce(), true)).toThrow();
    const recovered = authorizeEpochRecoveryWithCode(clean, sodium, body.challenge, body.grants, body.recovery, code, true);
    expect(recovered.authorityPublicKey).toBe(ownerProfile().pin.authorityPublicKey);
    expect(await clean.secrets.load(clean.scope('authoritySeed'))).toBe(null);
    expect(snapshotLocal()).toEqual(before);
  });
  it('rejects unsigned/other-authority proofs, wrong epochs/scope/restore and replay of a challenge in another request', async () => {
    const { body } = await challenge(), original = await authorizeEpochRecovery(device(), body.challenge, true);
    const { signature, ...unsigned } = original; void signature;
    const cases: unknown[] = [unsigned, { ...original, signature: crypto.sign(epochRecoverySigningInput(unsigned), sodium.randombytes_buf(32)) }];
    for (const field of ['serverId', 'vaultId', 'fromEpoch', 'toEpoch', 'restoreId', 'nonce'])
      cases.push(await grantSigned(body.challenge, { [field]: field === 'nonce' ? crypto.nonce() : crypto.uuid() }));
    const before = snapshotLocal();
    for (const authorization of cases) expect((await request('epoch-recovery-authorize', { authorization, knownGrants: ownerProfile().grants })).status).not.toBe(200);
    expect((await request('epoch-recovery-authorize', submission(original), other.accessToken)).status).toBe(403);
    expect((await pool.query('SELECT count(*) FROM sync_epoch_authorizations')).rows[0].count).toBe('0');
    expect(snapshotLocal()).toEqual(before);
  });
  it('expires on server time; preparation and response loss leave authority/outbox intact; retry survives restart', async () => {
    // First challenge is intentionally abandoned (fault after challenge/signature).
    const rows = (await pool.query('SELECT challenge FROM sync_epoch_challenges ORDER BY expires_at')).rows;
    const expired = rows[0].challenge as EpochRecoveryChallenge;
    const authorization = await authorizeEpochRecovery(device(), expired, true);
    await pool.query("UPDATE sync_epoch_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE challenge_id=$1", [expired.challengeId]);
    expect((await request('epoch-recovery-authorize', submission(authorization))).body.error).toBe('epoch_challenge_expired');
    const active = rows[1].challenge as EpochRecoveryChallenge, accepted = await authorizeEpochRecovery(device(), active, true);
    const before = snapshotLocal();
    await pool.query(`CREATE FUNCTION epoch_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_fault'; END $$;
      CREATE TRIGGER epoch_fault BEFORE INSERT ON sync_epoch_authorizations FOR EACH ROW EXECUTE FUNCTION epoch_fault();`);
    expect((await request('epoch-recovery-authorize', submission(accepted))).status).toBe(503);
    expect((await pool.query('SELECT consumed FROM sync_epoch_challenges WHERE challenge_id=$1', [active.challengeId])).rows[0].consumed).toBe(false);
    await pool.query('DROP TRIGGER epoch_fault ON sync_epoch_authorizations; DROP FUNCTION epoch_fault();');
    // A crash while freezing the old ciphertext must roll back permission consumption AND every archive row.
    await pool.query(`CREATE FUNCTION archive_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_archive_fault'; END $$;
      CREATE TRIGGER archive_fault BEFORE INSERT ON archive_sync_commits FOR EACH ROW EXECUTE FUNCTION archive_fault();`);
    expect((await request('epoch-recovery-authorize', submission(accepted))).status).toBe(503);
    expect((await pool.query('SELECT consumed FROM sync_epoch_challenges WHERE challenge_id=$1', [active.challengeId])).rows[0].consumed).toBe(false);
    expect((await pool.query('SELECT count(*) FROM sync_epoch_authorizations')).rows[0].count).toBe('0');
    for (const table of Object.keys(generationArchiveKeys))
      expect((await pool.query(`SELECT count(*) FROM archive_${table}`)).rows[0].count).toBe('0');
    await pool.query('DROP TRIGGER archive_fault ON archive_sync_commits; DROP FUNCTION archive_fault();');
    const result = await request('epoch-recovery-authorize', submission(accepted));
    expect(result.body).toMatchObject({ state: 'authorized_awaiting_baseline', activationAvailable: false });
    await new Promise<void>(resolve => server.close(() => resolve())); await startServer();
    await pool.query("UPDATE sync_epoch_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE challenge_id=$1", [active.challengeId]);
    // Exact retry is a read of one durable result, including after expiry, not a new acceptance.
    expect((await request('epoch-recovery-authorize', submission(accepted))).body).toEqual(result.body);
    const fresh = (await challenge()).body.challenge as EpochRecoveryChallenge;
    const different = await authorizeEpochRecovery(device(), fresh, true);
    expect((await request('epoch-recovery-authorize', submission(different))).body.error).toBe('epoch_recovery_already_authorized');
    expect((await pool.query('SELECT count(*) FROM sync_epoch_authorizations')).rows[0].count).toBe('1');
    const known = (await pool.query('SELECT known_grants FROM sync_epoch_authorizations')).rows[0].known_grants;
    expect(known.at(-1)).toMatchObject({ deviceId: secondaryProfile().deviceId, status: 'revoked' });
    expect(snapshotLocal()).toEqual(before);
    expect((await pool.query('SELECT pin FROM sync_vaults')).rows[0].pin.serverEpoch).toBe(epochA);
    expect((await request('commits', {})).body.error).toBe('invalid_http_proof');
    for (const table of [...tables, ...Object.keys(generationArchiveKeys).map(t => `archive_${t}`), 'sync_generations', 'sync_restores', 'sync_restore_vaults', 'sync_epoch_challenges', 'sync_epoch_authorizations']) {
      const persisted = (await pool.query(`SELECT coalesce(jsonb_agg(t),'[]')::text AS value FROM ${table} t`)).rows[0].value;
      for (const privateValue of [canary, code, 'DESKTOP_C2_AFTER_BACKUP', 'ANDROID_C3_OFFLINE'])
        expect(persisted.includes(privateValue)).toBe(false);
    }
  });
  it('archives exact restored ciphertext and plans C1+C2 from the owner graph while Android A is untouched', async () => {
    const before = snapshotLocal();
    for (const table of Object.keys(generationArchiveKeys)) {
      const source = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      const archive = (await pool.query(`SELECT to_jsonb(t)-'generation_epoch' AS row FROM archive_${table} t ORDER BY (to_jsonb(t)-'generation_epoch')::text`)).rows;
      expect(archive).toEqual(source);
    }
    expect((await pool.query('SELECT archive_sealed,state FROM sync_generations')).rows).toEqual([{ archive_sealed: true, state: 'active' }]);
    await expect(pool.query("UPDATE archive_sync_commits SET envelope_text='changed'")).rejects.toThrow('immutable');
    await expect(pool.query('DELETE FROM archive_sync_grants')).rejects.toThrow('immutable');
    await expect(pool.query('UPDATE sync_generations SET archive_sealed=false')).rejects.toThrow('immutable');
    await expect(pool.query("INSERT INTO sync_generations(vault_id,server_epoch,state) VALUES($1,$2,'active')", [oldVault(), crypto.uuid()])).rejects.toThrow();
    await pool.query(controlSchema + commitSchema + bindingSchema); // Idempotent migration preserves every sealed row.
    const authorization = (await pool.query('SELECT authorization_envelope FROM sync_epoch_authorizations')).rows[0].authorization_envelope;
    await prepareAnchorArchive({ db: bank.syncDatabase(), device: device(), acceptedAuthorization: authorization, confirmed: true,
      backup: () => createEpochAnchorBackup(bank.db, join(directory, 'anchor-generation-backup.sqlite')), inspectBackup: inspectEpochAnchorBackup });
    await bank.syncDatabase().run(planAnchorBaseline(authorization.restoreId, () => crypto.uuid()));
    const planned = bank.db.prepare('SELECT * FROM recovery_revision_mapping ORDER BY ordinal').all();
    expect(planned.map(r => JSON.parse(String(r.revision_b_json)).snapshot.description)).toEqual(expect.arrayContaining([canary, 'DESKTOP_C2_AFTER_BACKUP']));
    expect(planned).toHaveLength(2);
    const newIds = new Set(planned.map(r => r.revision_b));
    for (const old of before.desktop.sync_revisions) expect(newIds.has(old.revision_id)).toBe(false);
    expect(snapshotLocal()).toEqual(before);
    // Neither normal financial table nor pin/profile B is installed by planning.
    expect(bank.db.prepare('SELECT server_epoch FROM sync_local_state').get()!.server_epoch).toBe(epochA);
    expect((await pool.query('SELECT count(*) FROM sync_commits')).rows[0].count).toBe('1');
    expect((await request('epoch-recovery-activate', {})).status).toBe(404);
  });
  it('keeps pending authorization history across B→C and refuses A→C skipping unrecovered B', async () => {
    const epochB = environment.serverEpoch; environment.serverEpoch = crypto.uuid();
    const second = crypto.uuid();
    await pool.query('INSERT INTO sync_restores(restore_id,server_id,from_epoch,to_epoch,displaced_epoch,backup_manifest_sha256) VALUES($1,$2,$3,$4,$3,$5)', [second, environment.serverId, epochB, environment.serverEpoch, 'b'.repeat(64)]);
    await pool.query('INSERT INTO sync_restore_vaults(restore_id,vault_id,source_epoch) VALUES($1,$2,$3)', [second, oldVault(), epochA]);
    const before = snapshotLocal();
    expect((await challenge()).body.error).toBe('epoch_recovery_chain_required');
    const authorization = (await pool.query('SELECT authorization_envelope FROM sync_epoch_authorizations')).rows[0].authorization_envelope;
    expect((await request('epoch-recovery-authorize', submission(authorization))).body.error).toBe('epoch_recovery_chain_required');
    const epochC = environment.serverEpoch; environment.serverEpoch = epochA;
    expect((await challenge()).body.error).toBe('restore_record_required'); environment.serverEpoch = epochC;
    expect((await pool.query('SELECT count(*) FROM sync_restores')).rows[0].count).toBe('2');
    expect((await pool.query('SELECT count(*) FROM sync_epoch_authorizations')).rows[0].count).toBe('1');
    expect(snapshotLocal()).toEqual(before);
  });
  it('also refuses skipping a signed preparation when an older A snapshot is restored again', async () => {
    const displaced = environment.serverEpoch; environment.serverEpoch = crypto.uuid();
    const restore = crypto.uuid();
    await pool.query('INSERT INTO sync_restores(restore_id,server_id,from_epoch,to_epoch,displaced_epoch,backup_manifest_sha256) VALUES($1,$2,$3,$4,$5,$6)',
      [restore, environment.serverId, epochA, environment.serverEpoch, displaced, 'c'.repeat(64)]);
    await pool.query('INSERT INTO sync_restore_vaults(restore_id,vault_id,source_epoch) VALUES($1,$2,$3)', [restore, oldVault(), epochA]);
    const before = snapshotLocal();
    expect((await challenge()).body.error).toBe('epoch_recovery_chain_required');
    expect((await pool.query('SELECT count(*) FROM sync_epoch_authorizations')).rows[0].count).toBe('1');
    expect(snapshotLocal()).toEqual(before);
  });
});
