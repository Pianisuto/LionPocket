import { describe, expect, it } from 'vitest';
import { assertCommitReceipt } from './validation';
const v4 = '11111111-1111-4111-8111-111111111111';
const v5 = '22222222-2222-5222-8222-222222222222';
const receipt = {
  serverId: v4,
  serverEpoch: v4,
  vaultId: v4,
  commitId: v4,
  deviceId: v4,
  deviceSeq: '1',
  result: 'accepted',
  logPosition: '1',
  acceptedRegistryVersion: '1',
  envelopeSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  heads: [{ objectId: v5, revisionIds: [v4] }],
};
describe('receipt identity matches the existing envelope contract', () => {
  it('accepts UUIDv5 object identities used by priorities and slots, without relaxing commit/device IDs', () => {
    expect(() => assertCommitReceipt(receipt)).not.toThrow();
    expect(() => assertCommitReceipt({ ...receipt, commitId: v5 })).toThrow();
    expect(() =>
      assertCommitReceipt({
        ...receipt,
        heads: [
          {
            objectId: '22222222-2222-1222-8222-222222222222',
            revisionIds: [v4],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      assertCommitReceipt({
        ...receipt,
        heads: [{ objectId: v5, revisionIds: [v5] }],
      }),
    ).toThrow();
  });
});
