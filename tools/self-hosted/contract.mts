/** Disposable protocol + real SQLite adapter evidence; not native UI/Custom Tab evidence. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { SyncController, discoverOidc, type SyncSaved, type SyncSession, type SyncEnvironment, ProvisioningCrypto } from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../../apps/desktop/src/main/database';
import { sqliteTestConnection } from '../../apps/mobile/src/db/sqliteTestConnection';
import { migrate } from '../../apps/mobile/src/db/migrations';
import { MobileRepository } from '../../apps/mobile/src/db/repository';
import { mobileSyncDatabase } from '../../apps/mobile/src/sync/database';
import { loginOidc } from '../../apps/desktop/src/main/sync/oidc';
import { TestSecrets } from '../../apps/sync-server/src/testSupport';
import {createEpochAnchorBackup,inspectEpochAnchorBackup,inspectEpochActivationCheckpoint} from '../../apps/desktop/src/main/sync/epochBackup';
import { canonicalStringify } from '@lionpocket/sync-protocol';

const endpoint = 'https://sync.fixture.test';
await sodium.ready;
const phase = process.argv[2] ?? 'initial';
const statePath = '/fixtures/client-state.json';
let saved: { desktop?: SyncSaved; android?: SyncSaved; secrets?: [string, number[]][]; recovery?: string } = {};
try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* First clean run. */ }
const secrets = new TestSecrets();
for (const [scope, bytes] of saved.secrets ?? []) secrets.values.set(scope, Uint8Array.from(bytes));
const desktop = new LionPocketDatabase('/fixtures/desktop.sqlite');
const mobile = sqliteTestConnection('/fixtures/android.sqlite');
await migrate(mobile.db);
const repo = new MobileRepository(mobile.db, () => new ProvisioningCrypto(sodium).uuid());
if (phase === 'dns') {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith(endpoint)) return Promise.reject(new Error('ENOTFOUND fixture DNS outage'));
    return original(input, init);
  };
}
if (phase === 'initial') {
  // Start without binding; local-only writes never produce an endless outbox.
  desktop.db.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
  mobile.sqlite.exec('DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;');
  desktop.saveTransaction({ kind: 'expense', description: 'LP_SELFHOST_CANARY_DESCRIPTION_72319', notes: 'LP_SELFHOST_CANARY_NOTE_87931', plannedAmount: 98765.43, dueDate: '2026-10-02', status: 'planned' });
  assert.equal(desktop.db.prepare('SELECT count(*) AS n FROM sync_outbox').get()?.n, 0);
}
async function login(e: SyncEnvironment, android: boolean, username = 'fixture-alice'): Promise<SyncSession> {
  if (phase === 'expired') throw new Error('interaction_required');
  if (phase === 'revoked') return JSON.parse(await readFile('/fixtures/ephemeral-token-' + (android ? 'android' : 'desktop') + '.json', 'utf8'));
  const clientId = android ? e.oidc.androidClientId : e.oidc.desktopClientId;
  const redirect = android ? e.oidc.androidRedirect : e.oidc.desktopRedirect;
  if (!android) {
    const session = await loginOidc({ issuer: e.oidc.issuer, clientId, redirectUri: redirect }, async url => {
      // Drive only the IdP form; the production desktop adapter owns loopback,
      // PKCE, state, nonce, token exchange and JWT checks.
      const page = await fetch(url, { redirect: 'manual' });
      const html = await page.text();
      const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
      assert.ok(action); assert.equal(new URL(action).origin, new URL(e.oidc.issuer).origin);
      const response = await fetch(action, { method: 'POST', redirect: 'manual', headers: { cookie: page.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'fixture-only-password-78931', credentialId: '' }) });
      const location = response.headers.get('location'); assert.ok(location);
      const callback = new URL(location); assert.equal(callback.origin + callback.pathname, redirect);
      await fetch(location, { redirect: 'error' });
    });
    if (username === 'fixture-alice') await writeFile('/fixtures/ephemeral-token-desktop.json', JSON.stringify(session), { mode: 0o600 });
    return session;
  }
  const d = await discoverOidc(e.oidc.issuer);
  const verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const auth = new URL(d.authorizationEndpoint);
  auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state, nonce, prompt: 'login' }).toString();
  const page = await fetch(auth, { redirect: 'manual' });
  const html = await page.text();
  const action = /<form[^>]+action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
  assert.ok(action, 'Keycloak fixture login form available');
  assert.equal(new URL(action).origin, new URL(e.oidc.issuer).origin);
  const res = await fetch(action, { method: 'POST', redirect: 'manual', headers: { cookie: page.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'fixture-only-password-78931', credentialId: '' }) });
  const location = res.headers.get('location');
  assert.ok(location, 'Authorization Code issued without interactive required profile changes');
  const callback = new URL(location);
  assert.equal(callback.origin + callback.pathname, new URL(redirect).origin + new URL(redirect).pathname);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), e.oidc.issuer);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  const response = await fetch(d.tokenEndpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code, code_verifier: verifier }) });
  assert.ok(response.ok);
  const tokens = await response.json();
  const keys = createRemoteJWKSet(new URL(d.jwksUri));
  const id = await jwtVerify(tokens.id_token, keys, { issuer: e.oidc.issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['nonce', 'exp', 'iat', 'sub'] });
  const access = await jwtVerify(tokens.access_token, keys, { issuer: e.oidc.issuer, audience: 'lionpocket-sync-api', algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] });
  assert.equal(id.payload.nonce, nonce); assert.equal(id.payload.sub, access.payload.sub); assert.equal(access.payload.azp, clientId);
  const session = { accessToken: tokens.access_token, issuer: e.oidc.issuer, subject: access.payload.sub!, expiresAt: access.payload.exp! * 1000 };
  // Only a disposable security-test fixture, never native persistence. Used to
  // prove operator disable rejects an already issued JWT with a valid device proof.
  if (username === 'fixture-alice') await writeFile('/fixtures/ephemeral-token-' + (android ? 'android' : 'desktop') + '.json', JSON.stringify(session), { mode: 0o600 });
  return session;
}
const a = new SyncController({ epochBackup:{create:()=>createEpochAnchorBackup(desktop.db,'/fixtures/recovery-'+randomBytes(8).toString('hex')+'.sqlite'),inspect:inspectEpochAnchorBackup,inspectCheckpoint:inspectEpochActivationCheckpoint},db: desktop.syncDatabase(), secrets, sodium, dialect: 'desktop', storage: { load: async () => saved.desktop ? structuredClone(saved.desktop) : null, save: async value => { saved.desktop = structuredClone(value); } }, backup: async () => { const path = '/fixtures/pre-binding-' + randomBytes(8).toString('hex') + '.sqlite'; desktop.db.prepare('VACUUM INTO ?').run(path); return path; }, login: e => login(e, false) });
const b = new SyncController({ db: mobileSyncDatabase(mobile.db), secrets, sodium, dialect: 'android', storage: { load: async () => saved.android ? structuredClone(saved.android) : null, save: async value => { saved.android = structuredClone(value); } }, backup: async () => { const path = '/fixtures/pre-binding-android-' + randomBytes(8).toString('hex') + '.sqlite'; await mobile.db.executeAsync('VACUUM INTO ?', [path]); return path; }, login: e => login(e, true) });
a.setForeground(true); b.setForeground(true);
const input = { kind: 'income' as const, description: 'LP_SELFHOST_ANDROID_74321', plannedAmount: 0, actualAmount: null, dueDate: '2026-10-03', status: 'planned' as const };
try {
  if (phase === 'initial') {
    assert.equal((await a.status()).activity, 'local');
    await assert.rejects(a.configure('http://sync.fixture.test'));
    const originalFetch = globalThis.fetch;
    const originalDiscovery = await (await originalFetch(endpoint + '/v1/environment')).json();
    assert.deepEqual(await (await originalFetch(endpoint + '/.well-known/lionpocket')).json(), originalDiscovery);
    for (const delta of [{ controlVersion: 1 }, { controlVersion: 3 }, { protocolVersion: 2 }, { domainSchema: 2 }, { cryptoSuites: ['future'] }, { entityScopes: ['future'] }]) {
      globalThis.fetch = (url, init) => String(url).endsWith('/v1/environment') ? Promise.resolve(new Response(canonicalStringify({ ...originalDiscovery, ...delta }))) : originalFetch(url, init);
      await assert.rejects(a.configure(endpoint), /unsupported_/);
      assert.equal(saved.desktop, undefined);
      assert.equal(desktop.db.prepare('SELECT count(*) AS n FROM sync_outbox').get()?.n, 0);
    }
    globalThis.fetch = originalFetch;
    await a.configure(endpoint); await b.configure(endpoint);
    const discovery = await a.environment();
    assert.equal(discovery.controlVersion, 2); assert.equal(discovery.protocolVersion, 1); assert.equal(discovery.domainSchema, 1);
    assert.equal(discovery.entityScopes.length, 9);
    const first = await a.create();
    assert.equal(first.phase, 'recovery');
    assert.equal(desktop.db.prepare('SELECT binding_id FROM sync_local_state').get()?.binding_id, null);
    assert.equal(desktop.db.prepare('SELECT count(*) AS n FROM sync_outbox').get()?.n, 0);
    await assert.rejects(a.sync());
    const recovery = await a.generateRecovery(); saved.recovery = recovery.code;
    await assert.rejects(a.confirmRecovery('LP1.' + 'A'.repeat(43)));
    await a.confirmRecovery(recovery.code);
    assert.equal((await a.status()).phase, 'bound');
    await a.sync();
    const invitation = (await a.status()).invitation;
    const inspected = await b.inspectInvitation(invitation);
    await b.pair(invitation, inspected.fingerprint);
    await assert.rejects(b.receive()); // Unapproved device receives no financial keys/log.
    const request = (await a.requests()).requests[0];
    await a.approve(request.deviceId, request.fingerprint);
    await b.receive(); await b.sync();
    assert.equal((await repo.list({ month: '2026-10' }))[0].plannedAmount, 98765.43);
    await repo.save(input); await b.sync(); await a.sync();
    const tx = desktop.listTransactions({ month: '2026-10' }).find(t => t.description === input.description);
    assert.ok(tx); assert.equal(tx.actualAmount, null);
    desktop.saveTransaction({ ...input, id: tx.id, plannedAmount: 12.34 }); await a.sync(); await b.sync();
    assert.equal((await repo.list({ month: '2026-10' })).find(t => t.description === input.description)?.plannedAmount, 12.34);
    await assert.rejects(a.configure('https://operator-different.fixture.test'));
    // Account B cannot access account A's vault, even with the right proof.
    const other = await login(discovery, false, 'fixture-mallory');
    const { DeviceProvisioning, ProvisioningCrypto, fetchSyncHttp } = await import('@lionpocket/sync-local');
    const device = new DeviceProvisioning(saved.desktop!.profile!, secrets, new ProvisioningCrypto(sodium));
    const target = `/v1/vaults/${device.profile.pin.vaultId}/registry`, body = canonicalStringify({});
    const proof = await device.proof('POST', target, endpoint, body, other.accessToken);
    const encoded = device.crypto.encode(new TextEncoder().encode(canonicalStringify(proof)));
    await assert.rejects(fetchSyncHttp(endpoint).request(target, body, encoded, other.accessToken), /forbidden/);
    const own = await login(discovery, false);
    const valid = await device.proof('POST', target, endpoint, body, own.accessToken);
    const validEncoded = device.crypto.encode(new TextEncoder().encode(canonicalStringify(valid)));
    await fetchSyncHttp(endpoint).request(target, body, validEncoded, own.accessToken);
    await assert.rejects(fetchSyncHttp(endpoint).request(target, body, validEncoded, own.accessToken), /replay/);
    await assert.rejects(fetchSyncHttp(endpoint).request('/v1/redirect-canary', body, validEncoded, own.accessToken));
    const tokenOnly = await fetch(endpoint + target, { method: 'POST', headers: { 'x-lionpocket-control-version': '2', 'content-type': 'application/json', authorization: 'Bearer ' + own.accessToken }, body });
    assert.equal(tokenOnly.status, 403);
  } else if (phase === 'restart') {
    await a.sync(); await b.sync(); await a.sync(); await b.sync();
    assert.ok(desktop.listTransactions({ month: '2026-10' }).length >= 2);
    assert.equal((await repo.list({ month: '2026-10' })).length, desktop.listTransactions({ month: '2026-10' }).length);
    assert.equal((await a.status()).sync?.pending, 0); assert.equal((await b.status()).sync?.pending, 0);
  } else if (phase === 'recover-anchor') {
    b.setForeground(false);
    const secondaryBefore=Object.fromEntries((await import('@lionpocket/sync-local')).syncTables.map(t=>[t,mobile.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    const financialBefore=Object.fromEntries(Object.keys((await import('@lionpocket/sync-local')).financialTableTypes).map(t=>[t,desktop.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    await a.prepareServerRecovery(true);
    assert.equal((await a.status()).recoveryPhase,'prepared');
    await a.activateServerRecovery(true);
    assert.equal((await a.status()).recoveryPhase,'recovered');
    for(const [t,rows] of Object.entries(financialBefore))assert.deepEqual(desktop.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),rows);
    for(const [t,rows] of Object.entries(secondaryBefore))assert.deepEqual(mobile.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),rows);
    await a.sync();
    desktop.saveTransaction({...input,description:'C4_RECOVERED_'+saved.desktop!.profile!.pin.serverEpoch});
    await a.sync();
    assert.equal((await a.status()).sync?.pending,0);
  } else if (phase === 'offline-recovered') {
    b.setForeground(false);
    desktop.saveTransaction({...input,description:'C5_OFFLINE_RECOVERED'});
    assert.ok(desktop.getOverview('2026-10'));
    assert.ok(desktop.db.prepare("SELECT count(*) AS n FROM sync_outbox WHERE state='pending'").get()!.n);
    await assert.rejects(a.sync());
  } else if (phase === 'restart-recovered') {
    b.setForeground(false);
    await a.sync();
    assert.equal((await a.status()).sync?.pending,0);
    b.setForeground(true);await assert.rejects(b.sync(),/epoch_changed/);
    assert.ok(desktop.listTransactions({month:'2026-10'}).some(t=>t.description==='C5_OFFLINE_RECOVERED'));
  } else if (phase === 'epoch') {
    desktop.saveTransaction({ ...input, description: 'OFFLINE_EPOCH_PENDING' });
    const before = desktop.db.prepare('SELECT * FROM sync_outbox').all();
    await assert.rejects(a.sync(), /epoch_changed/);
    assert.deepEqual(desktop.db.prepare('SELECT * FROM sync_outbox').all(), before);
    assert.ok(desktop.listTransactions({ month: '2026-10' }).some(t => t.description === 'OFFLINE_EPOCH_PENDING'));
  } else if (['offline', 'revoked', 'dns', 'expired', 'tls', 'api', 'postgres', 'keycloak'].includes(phase)) {
    desktop.saveTransaction({ ...input, description: 'OFFLINE_DESKTOP_WRITE_' + phase });
    await repo.save({ ...input, description: 'OFFLINE_ANDROID_WRITE_' + phase });
    await assert.rejects(a.sync(), phase === 'revoked' ? /forbidden/ : /./); await assert.rejects(b.sync(), phase === 'revoked' ? /forbidden/ : /./);
    assert.ok(desktop.db.prepare("SELECT count(*) AS n FROM sync_outbox WHERE state='pending'").get()!.n);
    assert.ok(mobile.sqlite.prepare("SELECT count(*) AS n FROM sync_outbox WHERE state='pending'").get()!.n);
    assert.ok(desktop.getOverview('2026-10')); assert.ok(await repo.list({ month: '2026-10' }));
    assert.notEqual((await a.status()).activity, 'synced');
    assert.notEqual((await b.status()).activity, 'synced');
  } else throw new Error('Unknown fixture phase');
  console.log('Self-host normal desktop/Android SQLite contract: ' + phase + ' passed');
} finally {
  a.coordinator.dispose(); b.coordinator.dispose();
  saved.secrets = [...secrets.values].map(([scope, bytes]) => [scope, [...bytes]]);
  await writeFile(statePath, JSON.stringify(saved), { mode: 0o600 });
  desktop.db.close(); mobile.sqlite.close();
}
