import { syntheticBankOptIn } from './syntheticOptIn';
import { NativeModules } from 'react-native';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  DevelopmentSyncActions,
  ManualSync,
  bindSynthetic,
  fetchSyncHttp,
  type ProvisionedProfile,
  type RegistryResponse,
} from '@lionpocket/sync-local';
import {
  assertTrustPin,
  canonicalStringify,
  encodeUtf8,
  type TrustPin,
} from '@lionpocket/sync-protocol';
import type { NitroSQLiteConnection } from 'react-native-nitro-sqlite';
import { MobileRepository } from '../db/repository';
import { mobileSyncDatabase } from './database';
import { androidCrypto } from './crypto';
import { AndroidSecretStore } from './secretStore';
export function androidSyntheticOptIn() {
  return !!NativeModules.CryptoSpikeReport && syntheticBankOptIn();
}
const profileKey = 'sync-development-public-profile';
export class AndroidDevelopmentSync {
  private device?: DeviceProvisioning;
  private actions?: DevelopmentSyncActions;
  constructor(
    readonly db: NitroSQLiteConnection,
    readonly endpoint = 'http://127.0.0.1:8787',
  ) {
    if (!androidSyntheticOptIn()) throw new Error('sync_disabled');
  }
  private async save(identity: { issuer: string; subject: string }) {
    await this.db.executeAsync(
      'INSERT OR REPLACE INTO local_preferences(key,value) VALUES(?,?)',
      [
        profileKey,
        canonicalStringify({
          synthetic: true,
          identity,
          profile: this.device!.profile,
        }),
      ],
    );
  }
  async load() {
    if (this.device) return this.device;
    const [row] = (
      await this.db.executeAsync<{ value: string }>(
        'SELECT value FROM local_preferences WHERE key=?',
        [profileKey],
      )
    ).rows._array;
    if (!row) throw new Error('pairing_required');
    const saved = JSON.parse(row.value) as {
      synthetic: boolean;
      profile: ProvisionedProfile;
    };
    if (saved.synthetic !== true) throw new Error('synthetic_profile_required');
    this.device = new DeviceProvisioning(
      saved.profile,
      new AndroidSecretStore(),
      new ProvisioningCrypto(await androidCrypto()),
    );
    return this.device;
  }
  private async control(action: string, value: unknown, token: string) {
    const device = await this.load(),
      target = `/v1/vaults/${device.profile.pin.vaultId}/${action}`,
      body = canonicalStringify(value),
      proof = await device.proof('POST', target, this.endpoint, body, token);
    return fetchSyncHttp(this.endpoint).request(
      target,
      body,
      device.crypto.encode(encodeUtf8(canonicalStringify(proof))),
      token,
    ) as Promise<RegistryResponse>;
  }
  private async identity(session: {
    accessToken: string;
    issuer: string;
    subject: string;
  }) {
    const [row] = (
      await this.db.executeAsync<{ value: string }>(
        'SELECT value FROM local_preferences WHERE key=?',
        [profileKey],
      )
    ).rows._array;
    if (row) {
      const saved = JSON.parse(row.value) as {
        identity: { issuer: string; subject: string };
      };
      if (
        saved.identity.issuer !== session.issuer ||
        saved.identity.subject !== session.subject
      )
        throw new Error('identity_mismatch');
    }
  }
  async pair(
    pin: TrustPin,
    session: { accessToken: string; issuer: string; subject: string },
  ) {
    assertTrustPin(pin);
    const adapter = mobileSyncDatabase(this.db),
      [state] = await adapter.read('SELECT * FROM sync_local_state WHERE id=1');
    if (
      state.local_scope_id !== null ||
      (await adapter.read('SELECT id FROM transactions')).length
    )
      throw new Error('pairing_requires_empty_database');
    try {
      await this.load();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'pairing_required') throw e;
      this.device = await DeviceProvisioning.prepare(
        pin,
        new AndroidSecretStore(),
        new ProvisioningCrypto(await androidCrypto()),
      );
      await this.save(session);
    }
    await this.identity(session);
    const device = await this.load();
    if (canonicalStringify(device.profile.pin) !== canonicalStringify(pin))
      throw new Error('trust_pin_mismatch');
    const [row] = (
      await this.db.executeAsync<{ value: string }>(
        'SELECT value FROM local_preferences WHERE key=?',
        ['sync-development-pairing-request'],
      )
    ).rows._array;
    const request = row
      ? (JSON.parse(row.value) as Awaited<
          ReturnType<DeviceProvisioning['request']>
        >)
      : await device.request();
    if (!row)
      await this.db.executeAsync(
        'INSERT INTO local_preferences(key,value) VALUES(?,?)',
        ['sync-development-pairing-request', canonicalStringify(request)],
      );
    await this.control('pairings', request, session.accessToken);
    return request;
  }
  async receive(session: {
    accessToken: string;
    issuer: string;
    subject: string;
  }) {
    await this.identity(session);
    const device = await this.load();
    await device.receive(
      await this.control('registry', {}, session.accessToken),
    );
    await this.save(session);
    const adapter = mobileSyncDatabase(this.db),
      [state] = await adapter.read('SELECT * FROM sync_local_state WHERE id=1');
    if (state.local_scope_id === null)
      await new MobileRepository(this.db, () =>
        device.crypto.uuid(),
      ).enableSyntheticManualSyncPilot();
    if (state.binding_id === null)
      await adapter.run(
        bindSynthetic(device.profile, this.endpoint, device.crypto.uuid()),
      );
    return this.status();
  }
  async engine() {
    if (!this.actions) {
      const device = await this.load(),
        adapter = mobileSyncDatabase(this.db),
        [state] = await adapter.read(
          'SELECT * FROM sync_local_state WHERE id=1',
        );
      if (state.binding_id) {
        const [binding] = await adapter.read(
          'SELECT registry_json,checkpoint_json FROM sync_bindings WHERE binding_id=?',
          [String(state.binding_id)],
        );
        device.profile.grants = JSON.parse(String(binding.registry_json));
        device.profile.checkpoint = JSON.parse(String(binding.checkpoint_json));
      }
      this.actions = new DevelopmentSyncActions(
        new ManualSync(
          adapter,
          device,
          await androidCrypto(),
          'android',
          this.endpoint,
        ),
      );
    }
    return this.actions;
  }
  async status() {
    return (await this.engine()).status();
  }
  async sync(session: {
    accessToken: string;
    issuer: string;
    subject: string;
  }) {
    await this.identity(session);
    const actions = await this.engine();
    await actions.engine.sync(session.accessToken);
    await this.save(session);
    return actions.status();
  }
  async resolve(
    objectId: string,
    heads: string[],
    revisionId: string,
    recover: boolean,
  ) {
    return (await this.engine()).resolve(objectId, heads, revisionId, recover);
  }
}
