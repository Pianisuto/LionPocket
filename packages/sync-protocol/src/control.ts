import { canonicalStringify } from './canonical';
import type { DeviceGrant, RecoveryEnvelope, VaultKeyDelivery } from './types';

/** Pure byte contracts; authority/registry lookup and signature checks belong to adapters. */
export function deviceGrantSigningInput(grant: Omit<DeviceGrant, 'signature'>): string {
  if ('signature' in grant) throw new Error('Expected unsigned grant.');
  return canonicalStringify({ context: 'LionPocket/device-grant/v1', grant });
}
export function keyDeliverySigningInput(delivery: Omit<VaultKeyDelivery, 'signature'>): string {
  if ('signature' in delivery) throw new Error('Expected unsigned delivery.');
  return canonicalStringify({ context: 'LionPocket/key-delivery/v1', delivery });
}
export function recoveryAssociatedData(envelope: Omit<RecoveryEnvelope, 'ciphertext'>): string {
  if ('ciphertext' in envelope) throw new Error('Expected recovery header.');
  return canonicalStringify({ context: 'LionPocket/recovery/v1', header: envelope });
}
