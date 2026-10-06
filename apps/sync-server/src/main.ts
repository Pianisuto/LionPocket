import { readFileSync } from 'node:fs';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import { ProvisioningCrypto, normalizeEndpoint } from '@lionpocket/sync-local';
import { controlSchema, commitSchema, bindingSchema } from './schema';
import { controlServer, initialize } from './server';
import { keycloakIdentity } from './identity';
import { manualTransactionAcceptancePassed } from './acceptance';

const development = process.env.LIONPOCKET_SYNC_DEV === 'synthetic-only';
const betaChannel = process.env.LIONPOCKET_PRIVATE_BETA === 'isolated'; // Selects the isolated channel's OIDC clients and redirect.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. See docs/self-hosting.md.`);
  return value;
};
const origin = normalizeEndpoint(development ? 'http://127.0.0.1:8787' : required('SYNC_PUBLIC_ORIGIN'), development);
const issuer = development ? 'http://127.0.0.1:18080/realms/lionpocket-dev' : required('SYNC_OIDC_ISSUER');
const issuerUrl = new URL(issuer);
if ((!development && issuerUrl.protocol !== 'https:') || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash)
  throw new Error('Invalid HTTPS issuer.');
const pool = new pg.Pool(process.env.SYNC_DATABASE_URL || development ? {
  connectionString: process.env.SYNC_DATABASE_URL ?? 'postgresql://liondev:liondev@127.0.0.1:55432/lion_sync',
} : {
  host: required('SYNC_DB_HOST'), database: required('SYNC_DB_NAME'), user: required('SYNC_DB_USER'),
  password: readFileSync(required('SYNC_DB_PASSWORD_FILE'), 'utf8').trim(),
});
// Idle connection failures must never dump Pool/client credential objects.
pool.on('error', () => console.error('Sync database unavailable.'));
await sodium.ready;
await pool.query(controlSchema + commitSchema + bindingSchema);
const environment = await initialize(pool);
const server = controlServer({
  financialScope: development ? 'manual' : 'full',
  financialEnabled: !development || (manualTransactionAcceptancePassed && process.env.LIONPOCKET_SYNC_MANUAL === 'synthetic-only'),
  ...(!development ? { oidc: {
    issuer,
    desktopClientId: betaChannel ? 'lionpocket-desktop-dev' : 'lionpocket-desktop',
    androidClientId: betaChannel ? 'lionpocket-android-dev' : 'lionpocket-android',
    desktopRedirect: 'http://127.0.0.1:18761/callback',
    androidRedirect: betaChannel ? 'com.lionpocketmobile.beta:/callback' : 'com.lionpocketmobile:/callback',
  }} : {}),
  pool, crypto: new ProvisioningCrypto(sodium), environment, origin, identity: keycloakIdentity(issuer, development || betaChannel ? ["lionpocket-desktop-dev", "lionpocket-android-dev"] : ["lionpocket-desktop", "lionpocket-android"]),
});
server.listen(8787, development ? '127.0.0.1' : '0.0.0.0', () => console.log('LionPocket Sync API ready. Financial payloads are ciphertext.'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => { void pool.end(); }));
