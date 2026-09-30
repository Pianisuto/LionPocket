import { canonicalStringify } from './canonical';
import type { UnsignedCommit } from './types';

export function operationAssociatedData(commit: UnsignedCommit, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= commit.operations.length)
    throw new Error('Invalid operation index.');
  if ('signature' in commit) throw new Error('Expected unsigned commit.');
  const { operations, ...header } = commit;
  const { ciphertext, ...operation } = operations[index];
  void ciphertext;
  return canonicalStringify({ context: 'LionPocket/operation/v1', header,
    operation, operationIndex: index, operationCount: operations.length });
}
/** Ed25519 detached over UTF-8 of this exact string (not Ed25519ph). */
export function commitSigningInput(commit: UnsignedCommit): string {
  if ('signature' in commit) throw new Error('Expected unsigned commit.');
  return canonicalStringify({ context: 'LionPocket/commit/v1', commit });
}
