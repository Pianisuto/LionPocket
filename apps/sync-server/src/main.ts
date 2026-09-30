import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import { ProvisioningCrypto } from '@lionpocket/sync-local';
import { controlSchema, commitSchema, bindingSchema } from './schema';
import { controlServer, initialize } from './server';
import { keycloakIdentity } from './identity';
import { manualTransactionAcceptancePassed } from './acceptance';

if (process.env.LIONPOCKET_SYNC_DEV !== 'synthetic-only')
  throw new Error('Explicit synthetic-only development opt-in required.');
const pool = new pg.Pool({
  connectionString:
    process.env.SYNC_DATABASE_URL ??
    'postgresql://liondev:liondev@127.0.0.1:55432/lion_sync',
});
await sodium.ready;
await pool.query(controlSchema + commitSchema + bindingSchema);
const environment = await initialize(pool);
const server = controlServer({
  financialEnabled:
    manualTransactionAcceptancePassed &&
    process.env.LIONPOCKET_SYNC_MANUAL === 'synthetic-only',
  pool,
  crypto: new ProvisioningCrypto(sodium),
  environment,
  origin: 'http://127.0.0.1:8787',
  identity: keycloakIdentity('http://127.0.0.1:18080/realms/lionpocket-dev'),
});
server.listen(8787, '127.0.0.1', () =>
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
