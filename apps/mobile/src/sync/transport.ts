import {
  ManualSync,
  bindSynthetic,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { androidProvisioning } from './provisioning';
import { androidCrypto } from './crypto';
export { mobileSyncDatabase } from './database';
import { mobileSyncDatabase } from './database';
/** Only call with an explicitly opted-in, separate synthetic development bank. */
export async function androidManualSync(
  db: NitroSQLiteConnection,
  profile: ProvisionedProfile,
  endpoint: string,
) {
  const device = await androidProvisioning(profile),
    adapter = mobileSyncDatabase(db);
  return new ManualSync(
    adapter,
    device,
    await androidCrypto(),
    'android',
    endpoint,
  );
}
export async function bindAndroidSynthetic(
  db: NitroSQLiteConnection,
  profile: ProvisionedProfile,
  endpoint: string,
) {
  const crypto = await androidCrypto();
  const { uuidFromRandom } = await import('@lionpocket/sync-local');
  await mobileSyncDatabase(db).run(
    bindSynthetic(
      profile,
      endpoint,
      uuidFromRandom(crypto.randombytes_buf(16)),
    ),
  );
}
