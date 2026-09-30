import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { randomUUID } from 'node:crypto';
import { LionPocketDatabase } from '../database';
import {
  ManualSync,
  bindSynthetic,
  receivePage,
  type DeviceProvisioning,
} from '@lionpocket/sync-local';
import {
  canonicalStringify,
  encodeUtf8,
  commitSigningInput,
  operationAssociatedData,
  type CommitEnvelope,
} from '@lionpocket/sync-protocol';
import { founder, TestSecrets } from '../../../../sync-server/src/testSupport';
import { ProvisioningCrypto } from '@lionpocket/sync-local';
const banks: LionPocketDatabase[] = [];
afterEach(() => banks.splice(0).forEach((b) => b.db.close()));
beforeAll(() => sodium.ready);
const input = {
  kind: 'expense' as const,
  description: 'SYNTHETIC quarantine',
  plannedAmount: 0,
  dueDate: '2026-09-30',
  status: 'planned' as const,
};
async function setup() {
  const { client } = await founder(new ProvisioningCrypto(sodium)),
    bank = new LionPocketDatabase(':memory:');
  banks.push(bank);
  bank.enableSyntheticManualSyncPilot();
  await bank
    .syncDatabase()
    .run(bindSynthetic(client.profile, 'http://127.0.0.1:8787', randomUUID()));
  const engine = new ManualSync(
    bank.syncDatabase(),
    client,
    sodium,
    'desktop',
    'http://127.0.0.1:8787',
  );
  return { bank, engine, device: client };
}
async function receive(engine: ManualSync, envelopes: CommitEnvelope[]) {
  const [state] = await engine.db.read(
    'SELECT * FROM sync_local_state WHERE id=1',
  );
  await engine.db.run(
    receivePage(
      String(state.binding_id),
      String(state.received_cursor),
      String(envelopes.length),
      String(envelopes.length),
      envelopes.map((envelope, i) => ({
        envelope,
        logPosition: String(i + 1),
        acceptedRegistryVersion: '1',
      })),
      false,
    ),
  );
}
async function resign(device: DeviceProvisioning, envelope: CommitEnvelope) {
  const { signature, ...unsigned } = envelope;
  void signature;
  const seed = await device.secrets.load(device.scope('signingSeed'));
  if (!seed) throw new Error('seed missing');
  try {
    envelope.signature = device.crypto.sign(commitSigningInput(unsigned), seed);
  } finally {
    device.crypto.erase(seed);
  }
  return envelope;
}
describe('durable inbox quarantine and local crash boundaries', () => {
  it.each(['x'.repeat(65536), '🍋'.repeat(20000)])(
    'transports notes above the control quota and applies the following commit without echo',
    async (notes) => {
      const { bank: source, engine: sender, device } = await setup();
      source.saveTransaction({ ...input, notes });
      source.saveTransaction({
        ...input,
        description: 'SYNTHETIC following commit',
      });
      const rows = await sender.db.read(
        'SELECT commit_id FROM sync_outbox ORDER BY length(local_seq),local_seq',
      );
      const envelopes: CommitEnvelope[] = [];
      for (const row of rows)
        envelopes.push(JSON.parse(await sender.prepare(String(row.commit_id))));
      const bank = new LionPocketDatabase(':memory:');
      banks.push(bank);
      bank.enableSyntheticManualSyncPilot();
      await bank
        .syncDatabase()
        .run(bindSynthetic(device.profile, sender.endpoint, randomUUID()));
      const receiver = new ManualSync(
        bank.syncDatabase(),
        device,
        sodium,
        'desktop',
        sender.endpoint,
      );
      await receive(receiver, envelopes);
      await receiver.applyInbox();
      expect(
        await receiver.db.read(
          'SELECT notes FROM transactions WHERE description=?',
          [input.description],
        ),
      ).toEqual([{ notes }]);
      expect(
        await receiver.db.read(
          'SELECT description FROM transactions WHERE description=?',
          ['SYNTHETIC following commit'],
        ),
      ).toHaveLength(1);
      expect(await receiver.db.read('SELECT * FROM sync_outbox')).toHaveLength(
        0,
      );
      expect(
        (
          await receiver.db.read('SELECT applied_cursor FROM sync_local_state')
        )[0].applied_cursor,
      ).toBe('2');
      expect(() => bank.exportData(true)).not.toThrow();
    },
  );
  it('an unknown wire version survives backup and blocks applied cursor without losing received content', async () => {
    const { bank, engine } = await setup();
    bank.saveTransaction(input);
    const [out] = await engine.db.read('SELECT commit_id FROM sync_outbox');
    const valid = JSON.parse(
      await engine.prepare(String(out.commit_id)),
    ) as CommitEnvelope;
    const unknown = {
      ...valid,
      protocolVersion: 99,
      commitId: randomUUID(),
    } as unknown as CommitEnvelope;
    await receive(engine, [valid, unknown]);
    await engine.applyInbox();
    expect(
      (
        await engine.db.read(
          'SELECT received_cursor,applied_cursor FROM sync_local_state',
        )
      )[0],
    ).toEqual({ received_cursor: '2', applied_cursor: '1' });
    expect(
      (
        await engine.db.read(
          "SELECT state,envelope_json,last_error FROM sync_inbox WHERE log_position='2'",
        )
      )[0],
    ).toMatchObject({
      state: 'quarantined',
      envelope_json: canonicalStringify(unknown),
    });
    expect(() => bank.exportData(true)).not.toThrow();
  });
  it('missing parents, invalid signature and unknown domain payload are preserved with exact bytes', async () => {
    const { bank, engine, device } = await setup();
    bank.saveTransaction(input);
    const [out] = await engine.db.read('SELECT commit_id FROM sync_outbox');
    const valid = JSON.parse(
      await engine.prepare(String(out.commit_id)),
    ) as CommitEnvelope;
    const missing = JSON.parse(canonicalStringify(valid)) as CommitEnvelope;
    missing.commitId = randomUUID();
    missing.operations[0].opId = randomUUID();
    missing.operations[0].objectId = randomUUID();
    missing.operations[0].parents = [randomUUID()];
    const { signature, ...unsigned } = missing;
    void signature;
    const [revision] = await engine.db.read(
      'SELECT payload_json FROM sync_revisions',
    );
    const key = await device.secrets.load(device.scope('dataKey'));
    if (!key) throw new Error('key missing');
    try {
      missing.operations[0].ciphertext = device.crypto.encode(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          encodeUtf8(String(revision.payload_json)),
          encodeUtf8(operationAssociatedData(unsigned, 0)),
          null,
          device.crypto.decode(missing.operations[0].nonce),
          key,
        ),
      );
    } finally {
      device.crypto.erase(key);
    }
    await resign(device, missing);
    const invalid = { ...valid, commitId: randomUUID() },
      future = JSON.parse(canonicalStringify(valid)) as CommitEnvelope;
    future.commitId = randomUUID();
    future.operations[0].opId = randomUUID();
    future.operations[0].objectId = randomUUID();
    const { signature: sig, ...f } = future;
    void sig;
    const futureKey = await device.secrets.load(device.scope('dataKey'));
    if (!futureKey) throw new Error('key missing');
    try {
      future.operations[0].ciphertext = device.crypto.encode(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          encodeUtf8(
            canonicalStringify({
              ...JSON.parse(String(revision.payload_json)),
              domainSchema: 2,
            }),
          ),
          encodeUtf8(operationAssociatedData(f, 0)),
          null,
          device.crypto.decode(future.operations[0].nonce),
          futureKey,
        ),
      );
    } finally {
      device.crypto.erase(futureKey);
    }
    await resign(device, future);
    await receive(engine, [missing, invalid, future]);
    await engine.applyInbox();
    const rows = await engine.db.read(
      'SELECT state,last_error FROM sync_inbox ORDER BY log_position',
    );
    expect(rows.map((r) => r.state)).toEqual([
      'quarantined',
      'quarantined',
      'quarantined',
    ]);
    expect(rows[0].last_error).toBe('missing_parents');
    expect(rows[1].last_error).toBe('invalid_signature');
    expect(rows[2].last_error).toContain('Unsupported domain');
    expect(
      (await engine.db.read('SELECT count(*) n FROM sync_revisions'))[0].n,
    ).toBe(1);
    expect(() => bank.exportData(true)).not.toThrow();
  });
  it('cofre unavailability leaves pending content intact; an inbox SQL crash rolls back cursor and projection', async () => {
    const { bank, engine, device } = await setup();
    bank.saveTransaction(input);
    const secrets = device.secrets as TestSecrets;
    secrets.unavailable = true;
    const [out] = await engine.db.read('SELECT * FROM sync_outbox');
    await expect(engine.prepare(String(out.commit_id))).rejects.toThrow(
      'cofre_unavailable',
    );
    expect(
      (
        await engine.db.read(
          'SELECT envelope_json,device_seq FROM sync_outbox,sync_local_state',
        )
      )[0],
    ).toEqual({ envelope_json: null, device_seq: '0' });
    secrets.unavailable = false;
    const env = JSON.parse(
      await engine.prepare(String(out.commit_id)),
    ) as CommitEnvelope;
    bank.db.exec(
      "CREATE TEMP TRIGGER fail_page AFTER INSERT ON sync_inbox BEGIN SELECT RAISE(ABORT,'page crash'); END",
    );
    await expect(receive(engine, [env])).rejects.toThrow('page crash');
    expect(await engine.db.read('SELECT * FROM sync_inbox')).toHaveLength(0);
    expect(
      (await engine.db.read('SELECT received_cursor FROM sync_local_state'))[0]
        .received_cursor,
    ).toBe('0');
    bank.db.exec('DROP TRIGGER fail_page');
    await receive(engine, [env]);
    secrets.unavailable = true;
    await engine.applyInbox();
    expect(
      (await engine.db.read('SELECT state,last_error FROM sync_inbox'))[0],
    ).toMatchObject({ state: 'quarantined', last_error: 'cofre_unavailable' });
    secrets.unavailable = false;
    await engine.applyInbox();
    expect(
      (await engine.db.read('SELECT state FROM sync_inbox'))[0].state,
    ).toBe('applied');
  });
  it('a projection crash rolls back revision, identity and financial row before a durable quarantine', async () => {
    const { bank: source, engine: sender, device } = await setup();
    source.saveTransaction(input);
    const [out] = await sender.db.read('SELECT commit_id FROM sync_outbox');
    const envelope = JSON.parse(
      await sender.prepare(String(out.commit_id)),
    ) as CommitEnvelope;
    const bank = new LionPocketDatabase(':memory:');
    banks.push(bank);
    bank.enableSyntheticManualSyncPilot();
    await bank
      .syncDatabase()
      .run(
        bindSynthetic(device.profile, 'http://127.0.0.1:8787', randomUUID()),
      );
    const receiver = new ManualSync(
      bank.syncDatabase(),
      device,
      sodium,
      'desktop',
      'http://127.0.0.1:8787',
    );
    await receive(receiver, [envelope]);
    bank.db.exec(
      "CREATE TEMP TRIGGER fail_projection AFTER INSERT ON transactions BEGIN SELECT RAISE(ABORT,'projection crash'); END",
    );
    await receiver.applyInbox();
    expect(await receiver.db.read('SELECT * FROM sync_revisions')).toHaveLength(
      0,
    );
    expect(await receiver.db.read('SELECT * FROM sync_identity')).toHaveLength(
      0,
    );
    expect(await receiver.db.read('SELECT * FROM transactions')).toHaveLength(
      0,
    );
    expect(
      (await receiver.db.read('SELECT state,last_error FROM sync_inbox'))[0],
    ).toMatchObject({ state: 'quarantined', last_error: 'projection crash' });
    bank.db.exec('DROP TRIGGER fail_projection');
    await receiver.applyInbox();
    expect(await receiver.db.read('SELECT * FROM transactions')).toHaveLength(
      1,
    );
    expect(await receiver.db.read('SELECT * FROM sync_outbox')).toHaveLength(0);
    expect(
      (await receiver.db.read('SELECT applied_cursor FROM sync_local_state'))[0]
        .applied_cursor,
    ).toBe('1');
  });
  it('a successful HTTP status with a mismatched digest is not an ACK', async () => {
    const { bank, engine, device } = await setup();
    bank.saveTransaction(input);
    let sent: CommitEnvelope | undefined;
    const http = {
      request: async (target: string, body: string) => {
        if (target.endsWith('/registry'))
          return {
            pin: device.profile.pin,
            grants: device.profile.grants,
            delivery: null,
          };
        if (target.endsWith('/commits')) {
          sent = JSON.parse(body) as CommitEnvelope;
          return {
            serverId: sent.serverId,
            serverEpoch: sent.serverEpoch,
            vaultId: sent.vaultId,
            commitId: sent.commitId,
            deviceId: sent.deviceId,
            deviceSeq: sent.deviceSeq,
            result: 'accepted',
            logPosition: '1',
            acceptedRegistryVersion: '1',
            envelopeSha256: device.crypto.nonce(),
            heads: [
              {
                objectId: sent.operations[0].objectId,
                revisionIds: [sent.operations[0].opId],
              },
            ],
          };
        }
        const request = JSON.parse(body) as { bindingId: string };
        return {
          serverId: device.profile.pin.serverId,
          serverEpoch: device.profile.pin.serverEpoch,
          vaultId: device.profile.pin.vaultId,
          bindingId: request.bindingId,
          upperBound: '0',
          nextCursor: '0',
          hasMore: false,
          commits: [],
        };
      },
    };
    await expect(
      new ManualSync(
        engine.db,
        device,
        sodium,
        'desktop',
        engine.endpoint,
        http,
      ).sync('synthetic-test-token'),
    ).rejects.toThrow('receipt_mismatch');
    expect(
      (
        await engine.db.read(
          'SELECT state,receipt_json,last_error FROM sync_outbox',
        )
      )[0],
    ).toEqual({
      state: 'retry',
      receipt_json: null,
      last_error: 'receipt_mismatch',
    });
  });
});
