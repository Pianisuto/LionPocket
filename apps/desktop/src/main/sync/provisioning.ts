import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type ProvisionedProfile,
} from '@lionpocket/sync-local';
import { desktopCrypto } from './crypto';
import { DesktopSecretStore } from './secretStore';
/** Main-only. This is intentionally not exported through production IPC. */
export async function desktopProvisioning(
  profile: ProvisionedProfile,
  privateDirectory: string,
) {
  return new DeviceProvisioning(
    profile,
    new DesktopSecretStore(privateDirectory),
    new ProvisioningCrypto(await desktopCrypto()),
  );
}
