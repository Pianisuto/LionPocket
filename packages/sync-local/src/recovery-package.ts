import {
  assertBase64Url, assertDecimal64, assertKeyVersion, assertTrustPin,
  canonicalStringify, decodeCanonical, encodeUtf8, exactObject,
  type RegistryCheckpoint, type TrustPin,
} from '@lionpocket/sync-protocol';
import type { DeviceProvisioning, ProvisioningCrypto } from './provisioning';

/** Durable public locator and signed security floors; the recovery secret is kept separately. */
export interface RecoveryPackage {
  version: 1;
  purpose: 'vault-recovery';
  endpoint: string;
  pin: TrustPin;
  recoveryVersion: string;
  checkpoint: RegistryCheckpoint;
  keyVersion: number;
  signature: string;
}
const signingInput = (value: Omit<RecoveryPackage,'signature'>) =>
  canonicalStringify({context:'LionPocket/recovery-package/v1',...value});

export async function createRecoveryPackage(device: DeviceProvisioning, endpoint: string, recoveryVersion: string) {
  if (!device.profile.checkpoint) throw new Error('recovery_package_invalid');
  const seed = await device.secrets.load(device.scope('authoritySeed'));
  if (!seed) throw new Error('authority_secret_unavailable');
  try {
    const value: Omit<RecoveryPackage,'signature'> = {
      version:1, purpose:'vault-recovery', endpoint, pin:device.profile.pin,
      recoveryVersion, checkpoint:device.profile.checkpoint,
      keyVersion:device.profile.activeKeyVersion ?? device.profile.pin.keyVersion,
    };
    const artifact = {...value,signature:device.crypto.sign(signingInput(value),seed)};
    return 'LPR1.'+device.crypto.encode(encodeUtf8(canonicalStringify(artifact)));
  } finally { device.crypto.erase(seed); }
}
export function parseRecoveryPackage(input: string, crypto: ProvisioningCrypto): RecoveryPackage {
  try {
    const text = input.trim();
    if (!text.startsWith('LPR1.') || text.length>8192) throw new Error('invalid');
    const raw = text.slice(5), bytes = crypto.decode(raw);
    if (crypto.encode(bytes)!==raw) throw new Error('invalid');
    const obj = exactObject(decodeCanonical(bytes,8192),[
      'version','purpose','endpoint','pin','recoveryVersion','checkpoint','keyVersion','signature',
    ]);
    if (obj.version!==1 || obj.purpose!=='vault-recovery' || typeof obj.endpoint!=='string') throw new Error('invalid');
    assertTrustPin(obj.pin); assertDecimal64(obj.recoveryVersion,true); assertKeyVersion(obj.keyVersion);
    const checkpoint = exactObject(obj.checkpoint,['version','sha256']);
    assertDecimal64(checkpoint.version,true); assertBase64Url(checkpoint.sha256,32);
    assertBase64Url(obj.signature,64);
    const value = obj as unknown as RecoveryPackage;
    if (value.keyVersion < value.pin.keyVersion) throw new Error('invalid');
    const {signature,...unsigned} = value;
    if (!crypto.verify(signature,signingInput(unsigned),value.pin.authorityPublicKey)) throw new Error('invalid');
    return value;
  } catch { throw new Error('Pacote de recuperação inválido ou adulterado.'); }
}
