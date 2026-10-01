import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import { ProvisioningCrypto } from '@lionpocket/sync-local';
import { controlSchema, commitSchema, bindingSchema } from './schema';
import { controlServer, initialize } from './server';
import { keycloakIdentity } from './identity';
import { manualTransactionAcceptancePassed } from './acceptance';

const privateBeta = process.env.LIONPOCKET_PRIVATE_BETA === 'isolated';
if (!privateBeta && process.env.LIONPOCKET_SYNC_DEV !== 'synthetic-only')
  throw new Error('Explicit synthetic-only development opt-in required.');
const pool = new pg.Pool({
  connectionString:
    process.env.SYNC_DATABASE_URL ??
    'postgresql://liondev:liondev@127.0.0.1:55432/lion_sync',
});
await sodium.ready;
await pool.query(controlSchema + commitSchema + bindingSchema);
const environment = await initialize(pool);
const origin = privateBeta ? process.env.SYNC_PUBLIC_ORIGIN : 'http://127.0.0.1:8787';
const issuer = privateBeta ? process.env.SYNC_OIDC_ISSUER : 'http://127.0.0.1:18080/realms/lionpocket-dev';
if (!origin || !issuer || (privateBeta && (!origin.startsWith('https://') || !issuer.startsWith('https://')))) throw new Error('HTTPS origin and issuer required.');
const server = controlServer({
  privateBeta,
  ...(privateBeta ? {oidc:{issuer,desktopClientId:'lionpocket-desktop-dev',androidClientId:'lionpocket-android-dev',desktopRedirect:'http://127.0.0.1:18761/callback',androidRedirect:'com.lionpocketmobile.beta:/callback'}} : {}),
  financialEnabled:
    privateBeta || (manualTransactionAcceptancePassed &&
    process.env.LIONPOCKET_SYNC_MANUAL === 'synthetic-only'),
  pool,
  crypto: new ProvisioningCrypto(sodium),
  environment,
  origin,
  identity: keycloakIdentity(issuer),
});
server.listen(8787, privateBeta ? '0.0.0.0' : '127.0.0.1', () =>
  console.log(
    'Synthetic control API listening on http://127.0.0.1:8787; manualTransaction requires explicit synthetic-only opt-in.',
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      void pool.end();
    }),
  );
