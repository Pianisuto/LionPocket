import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { androidCrypto } from './crypto';
import { AndroidSecretStore } from './secretStore';
/** No production opt-in or financial transport; callable from the isolated native development harness. */
export async function androidProvisioning(profile: ProvisionedProfile) {
  return new DeviceProvisioning(
    profile,
    new AndroidSecretStore(),
    new ProvisioningCrypto(await androidCrypto()),
  );
}
