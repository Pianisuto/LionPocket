import {
  activeDevice,
  assertTrustPin,
  assertUuid,
  canonicalStringify,
  decodeCanonical,
  encodeUtf8,
  validateGrantChain,
  type PairingRequest,
  type TrustPin,
} from '@lionpocket/sync-protocol';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type ProvisionedProfile,
  type RegistryResponse,
} from './provisioning';
import { ManualSync, fetchSyncHttp, type TransportSodium } from './transport';
import { DevelopmentSyncActions } from './development';
import {
  acceptKeyCheckpoints,
  makeKeyCheckpoint,
  makeRecovery,
  openRecovery,
  validateKeyCheckpoints,
  type KeyCheckpoint,
  type SignedRecovery,
} from './beta-security';
import { updateRegistry } from './transport-state';
import {
  captureFinancial,
  reconnectFinancial,
  reviewLegacySeries,
  startFinancialBaseline,
  type ReviewedSlot,
} from './financial';
import type { LocalSyncDatabase, ProjectionDialect } from './transport-state';
import type { SecretStore } from './secrets';
import type { SqlWorkflow } from './manual';
export interface BetaEnvironment {
  serverId: string;
  serverEpoch: string;
  financialSyncEnabled: boolean;
  entityScopes: string[];
  oidc: {
    issuer: string;
    desktopClientId: string;
    androidClientId: string;
    desktopRedirect: string;
    androidRedirect: string;
  };
}
export interface BetaSession {
  accessToken: string;
  issuer: string;
  subject: string;
}
export interface BetaSaved {
  endpoint: string;
  identity?: { issuer: string; subject: string };
  profile?: ProvisionedProfile;
  request?: PairingRequest;
  phase?: 'creating' | 'pairing' | 'bound';
  owner?: boolean;
  pendingKeyCheckpoint?: KeyCheckpoint;
  pendingRecovery?: SignedRecovery;
  recoveryVersion?: string;
}
export interface BetaStorage {
  load(): Promise<BetaSaved | null>;
  save(value: BetaSaved): Promise<void>;
}
export interface BetaOptions {
  db: LocalSyncDatabase;
  secrets: SecretStore;
  sodium: TransportSodium;
  dialect: ProjectionDialect;
  storage: BetaStorage;
  backup(): Promise<string>;
  login(environment: BetaEnvironment): Promise<BetaSession>;
}
export function normalizeEndpoint(input: string): string {
  const u = new URL(input);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    (u.protocol !== 'https:' &&
      !(
        u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(u.hostname)
      ))
  )
    throw new Error('Use um endpoint HTTPS sem caminho.');
  return u.origin;
}
/** Complete foreground control flow shared by native clients. Storage contains public metadata only. */
export class BetaSync {
  constructor(readonly options: BetaOptions) {}
  private crypto() {
    return new ProvisioningCrypto(this.options.sodium);
  }
  async configure(endpoint: string) {
    const saved = await this.options.storage.load();
    const normalized = normalizeEndpoint(endpoint);
    if (saved?.profile && normalized !== saved.endpoint)
      throw new Error('Desconecte com revisão antes de trocar o servidor.');
    await this.environment(normalized);
    await this.options.storage.save({ ...saved, endpoint: normalized });
    return this.status();
  }
  async environment(endpoint?: string): Promise<BetaEnvironment> {
    const origin = normalizeEndpoint(
      endpoint ??
        (await this.options.storage.load())?.endpoint ??
        'https://sync-beta.lionslab.dev',
    );
    const response = await fetch(origin + '/v1/environment');
    if (!response.ok)
      throw new Error('Servidor indisponível. O banco continua local.');
    const text = await response.text();
    if (text.length > 65536) throw new Error('Invalid environment.');
    const e = decodeCanonical(encodeUtf8(text), 65536) as BetaEnvironment;
    assertUuid(e.serverId, '4');
    assertUuid(e.serverEpoch, '4');
    if (!e.financialSyncEnabled || !e.oidc || !Array.isArray(e.entityScopes))
      throw new Error('O servidor não habilitou a beta financeira.');
    const issuer = new URL(e.oidc.issuer);
    if (issuer.protocol !== 'https:' && new URL(origin).protocol !== 'http:')
      throw new Error('OIDC HTTPS required.');
    return e;
  }
  private async saved() {
    const s = await this.options.storage.load();
    if (!s) {
      await this.configure('https://sync-beta.lionslab.dev');
      return (await this.options.storage.load())!;
    }
    return s;
  }
  private device(saved: BetaSaved) {
    if (!saved.profile) throw new Error('Crie ou conecte um cofre.');
    return new DeviceProvisioning(
      saved.profile,
      this.options.secrets,
      this.crypto(),
    );
  }
  private async session(saved: BetaSaved) {
    const environment = await this.environment(saved.endpoint),
      session = await this.options.login(environment);
    if (
      session.issuer !== environment.oidc.issuer ||
      (saved.identity &&
        (session.issuer !== saved.identity.issuer ||
          session.subject !== saved.identity.subject))
    )
      throw new Error('A conta não corresponde ao cofre vinculado.');
    saved.identity = { issuer: session.issuer, subject: session.subject };
    return session;
  }
  private async control(
    saved: BetaSaved,
    action: string,
    value: unknown,
    session: BetaSession,
    create = false,
  ): Promise<RegistryResponse> {
    const device = this.device(saved),
      target = create
        ? '/v1/vaults'
        : `/v1/vaults/${device.profile.pin.vaultId}/${action}`,
      body = canonicalStringify(value);
    const proof = await device.proof(
      'POST',
      target,
      saved.endpoint,
      body,
      session.accessToken,
    );
    return fetchSyncHttp(saved.endpoint).request(
      target,
      body,
      device.crypto.encode(encodeUtf8(canonicalStringify(proof))),
      session.accessToken,
    ) as Promise<RegistryResponse>;
  }
  async create() {
    const s = await this.saved(),
      session = await this.session(s),
      environment = await this.environment(s.endpoint),
      crypto = this.crypto();
    if (!s.profile) {
      const device = await DeviceProvisioning.prepare(
        {
          serverId: environment.serverId,
          serverEpoch: environment.serverEpoch,
          vaultId: crypto.uuid(),
          founderDeviceId: crypto.uuid(),
          authorityPublicKey: crypto.encode(new Uint8Array(32)),
          keyVersion: 1,
        },
        this.options.secrets,
        crypto,
        true,
      );
      s.profile = device.profile;
      s.request = await device.request();
      s.phase = 'creating';
      s.owner = true;
      await this.options.storage.save(s);
    }
    if (s.phase !== 'creating')
      throw new Error('Já existe um cofre configurado.');
    const device = this.device(s);
    if (device.profile.grants.length) {
      device.acceptRegistry(await this.control(s, 'registry', {}, session));
      s.profile = device.profile;
      await this.options.storage.save(s);
      await this.bind(s, false);
      return this.status();
    }
    const grant = await device.grant(s.request!, s.request!.fingerprint);
    let response: RegistryResponse;
    try {
      response = await this.control(
        s,
        '',
        { pin: device.profile.pin, grant, request: s.request },
        session,
        true,
      );
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'vault_exists') throw e;
      response = await this.control(s, 'registry', {}, session);
    }
    device.acceptRegistry(response);
    s.profile = device.profile;
    await this.options.storage.save(s);
    await this.bind(s, false);
    return this.status();
  }
  invitation(saved: BetaSaved): string {
    if (!saved.profile) return '';
    return (
      'LPV1.' +
      this.crypto().encode(
        encodeUtf8(
          canonicalStringify({
            endpoint: saved.endpoint,
            pin: saved.profile.pin,
          }),
        ),
      )
    );
  }
  async inspectInvitation(invitation: string) {
    if (!invitation.startsWith('LPV1.') || invitation.length > 4096)
      throw new Error('Convite inválido.');
    const bytes = this.crypto().decode(invitation.slice(5));
    const parsed = decodeCanonical(bytes, 4096) as {
      endpoint: string;
      pin: TrustPin;
    };
    assertTrustPin(parsed.pin);
    normalizeEndpoint(parsed.endpoint);
    return {
      ...parsed,
      fingerprint: this.crypto().hash(
        canonicalStringify({
          context: 'LionPocket/trust-pin/v1',
          pin: parsed.pin,
        }),
      ),
    };
  }
  async pair(invitation: string, confirmedFingerprint: string) {
    const invite = await this.inspectInvitation(invitation);
    if (confirmedFingerprint !== invite.fingerprint)
      throw new Error(
        'Confira o código da autoridade no aparelho que criou o cofre.',
      );
    await this.configure(invite.endpoint);
    const s = await this.saved(),
      session = await this.session(s),
      e = await this.environment(s.endpoint);
    if (
      invite.pin.serverId !== e.serverId ||
      invite.pin.serverEpoch !== e.serverEpoch
    )
      throw new Error('epoch_changed');
    if (!s.profile) {
      const d = await DeviceProvisioning.prepare(
        invite.pin,
        this.options.secrets,
        this.crypto(),
      );
      s.profile = d.profile;
      s.request = await d.request();
      s.phase = 'pairing';
      await this.options.storage.save(s);
    }
    if (canonicalStringify(s.profile.pin) !== canonicalStringify(invite.pin))
      throw new Error('trust_pin_mismatch');
    await this.control(s, 'pairings', s.request, session);
    return this.status();
  }
  private async bind(s: BetaSaved, joining: boolean) {
    const [state] = await this.options.db.read(
      'SELECT * FROM sync_local_state WHERE id=1',
    );
    if (!state.binding_id) {
      const backup = await this.options.backup();
      await this.options.db.run(
        startFinancialBaseline(s.profile!, s.endpoint, backup, () =>
          this.crypto().uuid(),
        ),
      );
      if (joining)
        await this.options.db.run(
          (function* () {
            yield {
              sql: "UPDATE sync_bootstrap SET state='joining_review' WHERE id=1",
            };
          })(),
        );
    }
    s.phase = 'bound';
    await this.options.storage.save(s);
  }
  async receive() {
    const s = await this.saved(),
      session = await this.session(s),
      d = this.device(s);
    const response = await this.control(s, 'registry', {}, session);
    await d.receive(response);
    await acceptKeyCheckpoints(d, response);
    s.profile = d.profile;
    await this.options.storage.save(s);
    await this.bind(s, true);
    return this.status();
  }
  private async engine(s: BetaSaved) {
    const d = this.device(s),
      [state] = await this.options.db.read(
        'SELECT binding_id FROM sync_local_state WHERE id=1',
      );
    if (state.binding_id) {
      const [b] = await this.options.db.read(
        'SELECT registry_json,checkpoint_json FROM sync_bindings WHERE binding_id=?',
        [String(state.binding_id)],
      );
      d.profile.grants = JSON.parse(String(b.registry_json));
      d.profile.checkpoint = JSON.parse(String(b.checkpoint_json));
    }
    return new ManualSync(
      this.options.db,
      d,
      this.options.sodium,
      this.options.dialect,
      s.endpoint,
    );
  }
  async sync() {
    const s = await this.saved(),
      session = await this.session(s),
      engine = await this.engine(s);
    await engine.sync(session.accessToken);
    s.profile = engine.device.profile;
    await this.options.storage.save(s);
    return this.status();
  }
  async requests() {
    const s = await this.saved(),
      session = await this.session(s);
    return this.control(s, 'pairing-list', {}, session) as unknown as Promise<{
      requests: PairingRequest[];
    }>;
  }
  async approve(deviceId: string, fingerprint: string) {
    const s = await this.saved(),
      session = await this.session(s),
      device = this.device(s);
    device.acceptRegistry(await this.control(s, 'registry', {}, session));
    const pending = (await this.control(
      s,
      'pairing-list',
      {},
      session,
    )) as unknown as { requests: PairingRequest[] };
    const request = pending.requests.find((r) => r.deviceId === deviceId);
    if (!request) throw new Error('Pedido não encontrado.');
    device.acceptRegistry(
      await this.control(
        s,
        'grants',
        await device.grant(request, fingerprint),
        session,
      ),
    );
    s.profile = device.profile;
    await this.options.storage.save(s);
    await this.control(
      s,
      'deliveries',
      await device.delivery(deviceId),
      session,
    );
    await this.rotate(s, session);
    return this.status();
  }
  private async rotate(
    s: BetaSaved,
    session: BetaSession,
    recoveredKeys = false,
  ) {
    const d = this.device(s),
      currentResponse = await this.control(s, 'registry', {}, session);
    d.acceptRegistry(currentResponse);
    if (!recoveredKeys) await acceptKeyCheckpoints(d, currentResponse);
    else if (
      validateKeyCheckpoints(
        currentResponse.keyCheckpoints ?? [],
        d.profile.pin,
        currentResponse.grants,
        d,
      ) !== (d.profile.activeKeyVersion ?? 1)
    )
      throw new Error('recovery_stale');
    if (
      s.pendingKeyCheckpoint &&
      s.pendingKeyCheckpoint.keyVersion <= (d.profile.activeKeyVersion ?? 1) &&
      canonicalStringify(s.pendingKeyCheckpoint) !==
        canonicalStringify(
          d.profile.keyCheckpoints?.[d.profile.keyCheckpoints.length - 1],
        )
    ) {
      await this.options.db.run(
        (function* () {
          yield {
            sql: 'INSERT INTO sync_review VALUES(?,NULL,?,?)',
            params: [
              d.crypto.uuid(),
              'superseded_key_checkpoint',
              canonicalStringify(s.pendingKeyCheckpoint),
            ],
          };
        })(),
      );
      delete s.pendingKeyCheckpoint;
    }
    if (!s.pendingKeyCheckpoint) {
      s.pendingKeyCheckpoint = await makeKeyCheckpoint(d);
      await this.options.storage.save(s);
    }
    const response = await this.control(
      s,
      'key-checkpoints',
      s.pendingKeyCheckpoint,
      session,
    );
    d.acceptRegistry(response);
    await acceptKeyCheckpoints(d, response);
    s.profile = d.profile;
    delete s.pendingKeyCheckpoint;
    await this.options.db.run(updateRegistry(d.profile));
    await this.options.storage.save(s);
    const master = await this.options.secrets.load(d.scope('recoveryMaster'));
    if (master) {
      try {
        const current = (await this.control(
          s,
          'registry',
          {},
          session,
        )) as RegistryResponse & { recovery?: SignedRecovery | null };
        const next = String(
          BigInt(current.recovery?.envelope.recoveryVersion ?? '0') + 1n,
        );
        const recovered = await makeRecovery(
          d,
          this.options.sodium,
          next,
          master,
        );
        await this.control(s, 'recovery-store', recovered.recovery, session);
        s.recoveryVersion = next;
        await this.options.storage.save(s);
      } finally {
        d.crypto.erase(master);
      }
    }
  }
  async rotateKeys() {
    const s = await this.saved();
    await this.rotate(s, await this.session(s));
    return this.status();
  }
  async revoke(deviceId: string, confirmedDeviceId: string) {
    const s = await this.saved(),
      session = await this.session(s),
      d = this.device(s);
    if (deviceId !== confirmedDeviceId || deviceId === d.profile.deviceId)
      throw new Error(
        'Confira o aparelho a revogar. O aparelho atual não pode revogar a si mesmo.',
      );
    d.acceptRegistry(await this.control(s, 'registry', {}, session));
    const registry = validateGrantChain(
        d.profile.grants,
        d.profile.pin,
        d.crypto,
      ),
      target = activeDevice(registry.devices, deviceId);
    // A fresh request signed by the target is not required for revocation; authority signs the existing registered keys.
    const previous = d.profile.grants[d.profile.grants.length - 1],
      { deviceGrantSigningInput, nextRegistryVersion } =
        await import('@lionpocket/sync-protocol');
    const unsigned = {
      formatVersion: 1 as const,
      serverId: d.profile.pin.serverId,
      serverEpoch: d.profile.pin.serverEpoch,
      vaultId: d.profile.pin.vaultId,
      registryVersion: nextRegistryVersion(previous.registryVersion),
      previousRegistrySha256: d.crypto.hash(canonicalStringify(previous)),
      deviceId,
      signingPublicKey: target.signingPublicKey,
      boxPublicKey: target.boxPublicKey,
      status: 'revoked' as const,
    };
    const seed = await this.options.secrets.load(d.scope('authoritySeed'));
    if (!seed) throw new Error('authority_secret_unavailable');
    let signature: string;
    try {
      signature = d.crypto.sign(deviceGrantSigningInput(unsigned), seed);
    } finally {
      d.crypto.erase(seed);
    }
    d.acceptRegistry(
      await this.control(s, 'grants', { ...unsigned, signature }, session),
    );
    s.profile = d.profile;
    await this.options.storage.save(s);
    await this.rotate(s, session);
    return this.status();
  }
  async generateRecovery() {
    const s = await this.saved(),
      session = await this.session(s),
      d = this.device(s),
      response = (await this.control(
        s,
        'registry',
        {},
        session,
      )) as RegistryResponse & { recovery?: SignedRecovery | null };
    d.acceptRegistry(response);
    await acceptKeyCheckpoints(d, response);
    const version = String(
        BigInt(response.recovery?.envelope.recoveryVersion ?? '0') + 1n,
      ),
      created = await makeRecovery(d, this.options.sodium, version);
    s.pendingRecovery = created.recovery;
    await this.options.storage.save(s);
    return { code: created.code };
  }
  async confirmRecovery(code: string) {
    const s = await this.saved();
    if (!s.pendingRecovery) throw new Error('Gere um código de recovery.');
    openRecovery(this.device(s), this.options.sodium, s.pendingRecovery, code);
    const master = this.crypto().decode(code.slice(4));
    try {
      await this.options.secrets.store(
        this.device(s).scope('recoveryMaster'),
        master,
      );
    } finally {
      this.crypto().erase(master);
    }
    await this.control(
      s,
      'recovery-store',
      s.pendingRecovery,
      await this.session(s),
    );
    s.recoveryVersion = s.pendingRecovery.envelope.recoveryVersion;
    delete s.pendingRecovery;
    await this.options.storage.save(s);
    return this.status();
  }
  async recover(
    invitation: string,
    confirmedFingerprint: string,
    code: string,
  ) {
    const invite = await this.inspectInvitation(invitation);
    if (invite.fingerprint !== confirmedFingerprint)
      throw new Error('fingerprint_mismatch');
    await this.configure(invite.endpoint);
    const s = await this.saved();
    if (s.phase === 'bound')
      throw new Error('Use uma instalação separada para recuperar.');
    const session = await this.session(s),
      e = await this.environment(s.endpoint);
    if (
      e.serverId !== invite.pin.serverId ||
      e.serverEpoch !== invite.pin.serverEpoch
    )
      throw new Error('epoch_changed');
    if (!s.profile) {
      const d = await DeviceProvisioning.prepare(
        invite.pin,
        this.options.secrets,
        this.crypto(),
      );
      s.profile = d.profile;
      s.request = await d.request();
      s.phase = 'pairing';
      await this.options.storage.save(s);
    }
    const d = this.device(s),
      response = (await this.control(
        s,
        'recovery-fetch',
        { request: s.request },
        session,
      )) as RegistryResponse & { recovery: SignedRecovery | null };
    if (!response.recovery) throw new Error('recovery_unavailable');
    const bundle = openRecovery(
      d,
      this.options.sodium,
      response.recovery,
      code,
    );
    const registry = validateGrantChain(
      response.grants,
      d.profile.pin,
      d.crypto,
    );
    d.profile.grants = response.grants;
    d.profile.checkpoint = registry.checkpoint;
    const authority = d.crypto.decode(bundle.authoritySignSeed);
    try {
      await this.options.secrets.store(d.scope('authoritySeed'), authority);
    } finally {
      d.crypto.erase(authority);
    }
    for (const k of bundle.dataKeys) {
      const key = d.crypto.decode(k.vaultKey);
      try {
        await this.options.secrets.store(d.scope('dataKey', k.keyVersion), key);
      } finally {
        d.crypto.erase(key);
      }
    }
    d.profile.activeKeyVersion = bundle.activeKeyVersion;
    d.profile.keyCheckpoints = (response.keyCheckpoints ?? []).filter(
      (k) => k.keyVersion <= bundle.activeKeyVersion,
    );
    const master = d.crypto.decode(code.slice(4));
    try {
      await this.options.secrets.store(d.scope('recoveryMaster'), master);
    } finally {
      d.crypto.erase(master);
    }
    if (
      response.grants.some(
        (g) => g.deviceId === d.profile.deviceId && g.status === 'approved',
      )
    )
      d.acceptRegistry(response);
    else {
      const grant = await d.grant(s.request!, s.request!.fingerprint);
      d.acceptRegistry(
        await this.control(
          s,
          'recover',
          { request: s.request, grant },
          session,
        ),
      );
    }
    s.profile = d.profile;
    s.owner = true;
    s.recoveryVersion = bundle.recoveryVersion;
    await this.options.storage.save(s);
    await this.rotate(s, session, true);
    await this.bind(s, true);
    return this.status();
  }
  async reconnectRestored(confirm: boolean) {
    if (!confirm)
      throw new Error('Revise a cópia restaurada antes de reconectar.');
    const s = await this.saved(),
      e = await this.environment(s.endpoint);
    if (
      e.serverId !== s.profile?.pin.serverId ||
      e.serverEpoch !== s.profile?.pin.serverEpoch
    )
      throw new Error('epoch_changed');
    const backup = await this.options.backup();
    await this.options.db.run(
      reconnectFinancial(s.profile!, s.endpoint, backup, () =>
        this.crypto().uuid(),
      ),
    );
    return this.status();
  }
  async pause(paused: boolean) {
    await this.options.db.run(
      (function* () {
        yield {
          sql: 'UPDATE sync_control SET paused=? WHERE id=1',
          params: [paused ? 1 : 0],
        };
      })(),
    );
    return this.status();
  }
  async seriesReviews() {
    const result: {
      entityType: 'recurring' | 'installmentPurchase';
      localId: string;
      description: string;
      frequency: string;
      scheduleEpoch: string;
      slots: {
        localId: string;
        description: string;
        status: string;
        currentDate: string;
        installmentNumber: number | null;
      }[];
    }[] = [];
    for (const meta of await this.options.db.read(
      "SELECT * FROM sync_series WHERE identity_status='identity_unresolved'",
    )) {
      const type = String(meta.entity_type) as
          'recurring' | 'installmentPurchase',
        table =
          type === 'recurring' ? 'recurring_expenses' : 'installment_purchases',
        [row] = await this.options.db.read(
          `SELECT * FROM ${table} WHERE id=?`,
          [meta.local_id],
        );
      const slots = await this.options.db.read(
        'SELECT * FROM transactions WHERE source_type=? AND source_id=? ORDER BY due_date,id',
        [type === 'recurring' ? 'recurring' : 'installment', meta.local_id],
      );
      result.push({
        entityType: type,
        localId: String(meta.local_id),
        description: String(row.description),
        frequency: String(row.frequency ?? 'installment'),
        scheduleEpoch: String(meta.schedule_epoch),
        slots: slots.map((t) => ({
          localId: String(t.id),
          description: String(t.description),
          status: String(t.status),
          currentDate: String(
            t.occurrence_date ?? t.purchase_date ?? t.due_date,
          ),
          installmentNumber: t.installment_number as number | null,
        })),
      });
    }
    return result;
  }
  async reviewSeries(
    type: 'recurring' | 'installmentPurchase',
    localId: string,
    slots: ReviewedSlot[],
  ) {
    if (
      !['recurring', 'installmentPurchase'].includes(type) ||
      !Array.isArray(slots)
    )
      throw new Error('invalid_series_review');
    await this.options.db.run(
      reviewLegacySeries(type, localId, slots, () => this.crypto().uuid()),
    );
    return this.status();
  }
  async reviewLegacyImport(objectId: string, confirm: boolean) {
    if (!confirm) throw new Error('Confirme a origem manual do registro.');
    const [identity] = await this.options.db.read(
      "SELECT local_id FROM sync_identity WHERE object_id=? AND entity_type='transaction'",
      [objectId],
    );
    if (!identity) throw new Error('identity_missing');
    const uuid = () => this.crypto().uuid();
    await this.options.db.run(
      (function* (): SqlWorkflow {
        const [tx] = yield {
          sql: "SELECT * FROM transactions WHERE id=? AND source_type='imported'",
          params: [identity.local_id],
        };
        if (!tx) throw new Error('import_review_missing');
        yield {
          sql: 'INSERT INTO sync_review VALUES(?,?,?,?)',
          params: [
            uuid(),
            objectId,
            'legacy_import_review_provenance',
            canonicalStringify(tx),
          ],
        };
        yield {
          sql: "UPDATE transactions SET source_type='manual',source_id=NULL WHERE id=?",
          params: [identity.local_id],
        };
        yield* captureFinancial(uuid);
      })(),
    );
    return this.status();
  }
  async confirmLegacyDeletion(objectId: string, confirm: boolean) {
    if (!confirm) throw new Error('Confirme a exclusão agora.');
    const [identity] = await this.options.db.read(
      'SELECT * FROM sync_identity WHERE object_id=?',
      [objectId],
    );
    if (!identity) throw new Error('identity_missing');
    const tables: Record<string, string> = {
        category: 'categories',
        paymentMethod: 'payment_methods',
        card: 'cards',
        transaction: 'transactions',
        recurring: 'recurring_expenses',
        installmentPurchase: 'installment_purchases',
        goal: 'goals',
      },
      table = tables[String(identity.entity_type)];
    if (!table) throw new Error('invalid_delete_review');
    const uuid = () => this.crypto().uuid();
    await this.options.db.run(
      (function* (): SqlWorkflow {
        const [row] = yield {
          sql: `SELECT * FROM ${table} WHERE id=?`,
          params: [identity.local_id],
        };
        if (!row) {
          const [review] = yield {
            sql: "SELECT * FROM sync_review WHERE object_id=? AND reason='restored_missing_record'",
            params: [objectId],
          };
          if (!review) throw new Error('delete_review_missing');
          yield {
            sql: "INSERT INTO sync_dirty VALUES(?,?,'delete',?) ON CONFLICT(table_name,local_id) DO UPDATE SET operation='delete',row_json=excluded.row_json",
            params: [
              table,
              identity.local_id,
              canonicalStringify({
                id: identity.local_id,
                deleted_at: new Date().toISOString(),
              }),
            ],
          };
          yield* captureFinancial(uuid);
          yield {
            sql: "DELETE FROM sync_review WHERE object_id=? AND reason='restored_missing_record'",
            params: [objectId],
          };
          return;
        }
        if (!row.deleted_at) throw new Error('delete_review_missing');
        yield {
          sql: "INSERT INTO sync_dirty VALUES(?,?,'update',?) ON CONFLICT(table_name,local_id) DO UPDATE SET operation='update',row_json=excluded.row_json",
          params: [table, identity.local_id, canonicalStringify(row)],
        };
        yield* captureFinancial(uuid);
      })(),
    );
    return this.status();
  }
  async catalogReviews() {
    const s = await this.saved(),
      engine = await this.engine(s),
      rows = await this.options.db.read(
        "SELECT commit_id FROM sync_inbox WHERE state='quarantined' AND last_error='catalog_identity_review'",
      );
    const result: {
      commitId: string;
      objectId: string;
      entityType: string;
      localId: string;
      localName: string;
      remoteName: string;
    }[] = [];
    for (const row of rows)
      for (const op of await engine.inspectInbox(String(row.commit_id))) {
        if (
          op.revision.action !== 'put' ||
          !['category', 'paymentMethod', 'card'].includes(
            op.revision.entityType,
          )
        )
          continue;
        const value = op.revision.snapshot as { name: string; kind?: string },
          table =
            op.revision.entityType === 'category'
              ? 'categories'
              : op.revision.entityType === 'card'
                ? 'cards'
                : 'payment_methods';
        const matches = await this.options.db.read(
          `SELECT id,name FROM ${table} WHERE name=?${op.revision.entityType === 'category' ? ' AND kind=?' : ''}`,
          op.revision.entityType === 'category'
            ? [value.name, value.kind!]
            : [value.name],
        );
        for (const match of matches)
          result.push({
            commitId: String(row.commit_id),
            objectId: op.objectId,
            entityType: op.revision.entityType,
            localId: String(match.id),
            localName: String(match.name),
            remoteName: value.name,
          });
      }
    return result;
  }
  async preserveBothCatalogs(
    commitId: string,
    objectId: string,
    newLocalName: string,
  ) {
    const review = (await this.catalogReviews()).find(
      (r) => r.commitId === commitId && r.objectId === objectId,
    );
    if (
      !review ||
      !newLocalName.trim() ||
      newLocalName.trim() === review.remoteName
    )
      throw new Error('Revise o cadastro e escolha um nome distinto.');
    const table =
      review.entityType === 'category'
        ? 'categories'
        : review.entityType === 'card'
          ? 'cards'
          : 'payment_methods';
    await this.options.db.run(
      (function* () {
        yield {
          sql: `UPDATE ${table} SET name=? WHERE id=?`,
          params: [newLocalName.trim(), review.localId],
        };
      })(),
    );
    const s = await this.saved();
    await (await this.engine(s)).applyInbox();
    return this.status();
  }
  async preserveCatalogBatch(suffix: string, confirmed: boolean) {
    if (!confirmed || !suffix.trim() || suffix.length > 60)
      throw new Error('Confira a lista e escolha um sufixo local.');
    const reviews = await this.catalogReviews(),
      unique = new Map(reviews.map((r) => [r.entityType + ':' + r.localId, r]));
    await this.options.db.run(
      (function* (): SqlWorkflow {
        for (const r of unique.values()) {
          const table =
            r.entityType === 'category'
              ? 'categories'
              : r.entityType === 'card'
                ? 'cards'
                : 'payment_methods';
          yield {
            sql: `UPDATE ${table} SET name=? WHERE id=?`,
            params: [`${r.localName} (${suffix.trim()})`, r.localId],
          };
        }
      })(),
    );
    const s = await this.saved();
    await (await this.engine(s)).applyInbox();
    return this.status();
  }
  async confirmCombination() {
    const [n] = await this.options.db.read(
      "SELECT count(*) AS n FROM sync_inbox WHERE state='quarantined'",
    );
    if (n.n)
      throw new Error(
        'Revise os cadastros e a quarentena antes de enviar a base.',
      );
    await this.options.db.run(
      (function* () {
        yield { sql: "UPDATE sync_bootstrap SET state='confirmed' WHERE id=1" };
      })(),
    );
    return this.status();
  }
  async resolve(
    objectId: string,
    heads: string[],
    revisionId: string,
    recover: boolean,
  ) {
    const s = await this.saved();
    await new DevelopmentSyncActions(await this.engine(s)).resolve(
      objectId,
      heads,
      revisionId,
      recover,
    );
    return this.status();
  }
  async status() {
    const saved = await this.options.storage.load(),
      [state] = await this.options.db.read(
        'SELECT * FROM sync_local_state WHERE id=1',
      );
    const sync =
      saved?.phase === 'bound'
        ? await new DevelopmentSyncActions(await this.engine(saved)).status()
        : null;
    const counts: Record<string, number> = {};
    for (const table of [
      'categories',
      'payment_methods',
      'cards',
      'transactions',
      'recurring_expenses',
      'installment_purchases',
      'goals',
    ])
      counts[table] = Number(
        (await this.options.db.read(`SELECT count(*) AS n FROM ${table}`))[0].n,
      );
    const [bootstrap] = await this.options.db.read(
      'SELECT * FROM sync_bootstrap WHERE id=1',
    );
    const [control] = await this.options.db.read(
      'SELECT * FROM sync_control WHERE id=1',
    );
    return {
      restoreReview: state.mode === 'disabled' && !!state.binding_id,
      activeKeyVersion: saved?.profile?.activeKeyVersion ?? 1,
      recoveryVersion: saved?.recoveryVersion ?? '0',
      endpoint: saved?.endpoint ?? 'https://sync-beta.lionslab.dev',
      phase: saved?.phase ?? 'local',
      owner: saved?.owner ?? false,
      invitation: saved?.owner ? this.invitation(saved) : '',
      authorityFingerprint: saved?.profile
        ? this.crypto().hash(
            canonicalStringify({
              context: 'LionPocket/trust-pin/v1',
              pin: saved.profile.pin,
            }),
          )
        : '',
      pairingFingerprint: saved?.request?.fingerprint ?? '',
      deviceId: saved?.profile?.deviceId ?? '',
      devices: [
        ...new Map(
          (saved?.profile?.grants ?? []).map((g) => [g.deviceId, g]),
        ).values(),
      ],
      paused: !!control.paused,
      joiningReview: bootstrap?.state === 'joining_review',
      counts,
      sync,
      reviews: await this.options.db.read(
        "SELECT * FROM sync_review WHERE reason NOT IN ('active_key_version','reemission_provenance','legacy_import_review_provenance') AND reason NOT LIKE 'import_receipt:%'",
      ),
      quarantine: await this.options.db.read(
        "SELECT commit_id,last_error FROM sync_inbox WHERE state='quarantined'",
      ),
      mode: String(state.mode),
    };
  }
}
export type SeriesReview = Awaited<
  ReturnType<BetaSync['seriesReviews']>
>[number];
export type CatalogReview = Awaited<
  ReturnType<BetaSync['catalogReviews']>
>[number];
export type BetaStatus = Awaited<ReturnType<BetaSync['status']>>;
