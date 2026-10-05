import {
  initialSeriesChoices,
  seriesDecisionGroups,
  seriesPendingReason,
  seriesReviewError,
  type LegacySeriesReview,
} from './series-review';
import {
  prepareAnchorArchive,
  planAnchorBaseline,
  type AnchorBackupInspection,
  type VerifiedAnchorBackup,
} from "./epoch-archive";
import { authorizeEpochRecovery } from "./epoch-recovery";
import {
  prepareOperationalB,
  confirmOperationalBRecovery,
  stageOperationalB,
} from "./epoch-preparation";
import {
  requestAnchorActivation,
  resumeAnchorActivation,
  type AnchorActivationOptions,
} from "./epoch-activation";
import type {
  EpochRecoveryAuthorization,
  EpochTransition,
} from "@lionpocket/sync-protocol";
import { assertCompatibleEnvironment } from './compatibility';
import { bankSyncCoordinator, type SyncCoordinator } from './coordinator';
import { syncFetchText } from './network';
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
} from './security';
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
export interface SyncEnvironment {
  controlVersion?: number;
  protocolVersion?: number;
  domainSchema?: number;
  serverId: string;
  serverEpoch: string;
  financialSyncEnabled: boolean;
  entityScopes: string[];
  audience?: string;
  cryptoSuites?: string[];
  oidc: {
    issuer: string;
    desktopClientId: string;
    androidClientId: string;
    desktopRedirect: string;
    androidRedirect: string;
  };
}
export interface SyncSession {
  accessToken: string;
  issuer: string;
  subject: string;
  /** Validated access-token expiration, milliseconds since epoch. Never persisted. */
  expiresAt?: number;
}
export interface SyncSaved {
  endpoint: string;
  identity?: { issuer: string; subject: string };
  profile?: ProvisionedProfile;
  request?: PairingRequest;
  phase?: 'creating' | 'recovery' | 'pairing' | 'bound';
  discovered?: SyncEnvironment;
  owner?: boolean;
  pendingKeyCheckpoint?: KeyCheckpoint;
  pendingRecovery?: SignedRecovery;
  recoveryVersion?: string;
}
export interface SyncStorage {
  load(): Promise<SyncSaved | null>;
  save(value: SyncSaved): Promise<void>;
}
export interface SyncOptions {
  db: LocalSyncDatabase;
  secrets: SecretStore;
  sodium: TransportSodium;
  dialect: ProjectionDialect;
  storage: SyncStorage;
  backup(): Promise<string>;
  epochBackup?: {
    create(): Promise<VerifiedAnchorBackup>;
    inspect(path: string): Promise<AnchorBackupInspection>;
    inspectCheckpoint(
      path: string,
      restoreId: string,
    ): Promise<{ sha256: string; requestSha256: string; phase: string }>;
  };
  defaultEndpoint?: string;
  /** Only isolated synthetic harnesses may use loopback HTTP. Native clients never set this. */
  allowLocalDevelopment?: boolean;
  /** Legacy test fixtures can exercise the old binding order; native onboarding always requires recovery. */
  requireRecoveryConfirmation?: boolean;
  login(environment: SyncEnvironment): Promise<SyncSession>;
}
export function normalizeEndpoint(input: string, allowLocalDevelopment = false): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error('Use uma URL HTTPS válida, como https://sync.exemplo.com.'); }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    (u.protocol !== 'https:' &&
      !(
        allowLocalDevelopment && u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(u.hostname)
      ))
  )
    throw new Error('Use um endpoint HTTPS sem caminho.');
  return u.origin;
}
/** Complete foreground control flow shared by native clients. Storage contains public metadata only. */
export class SyncController {
  readonly coordinator: SyncCoordinator;
  private cachedSession?: SyncSession;
  constructor(readonly options: SyncOptions) {
    this.coordinator = bankSyncCoordinator(options.db, {
      eligible: async () => {
        if (await this.incompleteActivation()) return false;
        const saved = await options.storage.load();
        const [state] = await options.db.read(
          'SELECT mode,binding_id FROM sync_local_state WHERE id=1',
        );
        const [control] = await options.db.read(
          'SELECT paused FROM sync_control WHERE id=1',
        );
        return (
          saved?.phase === 'bound' &&
          state.mode === 'financial' &&
          !!state.binding_id &&
          !control.paused
        );
      },
      cycle: (interactive, signal) => this.syncCycle(interactive, signal),
    });
  }
  private async incompleteActivation() {
    if (
      !(
        await this.options.db.read(
          "SELECT name FROM sqlite_master WHERE name='recovery_activation_saga'",
        )
      ).length
    )
      return null;
    return (
      (
        await this.options.db.read(
          "SELECT * FROM recovery_activation_saga WHERE phase!='recovered'",
        )
      )[0] ?? null
    );
  }
  private async requireRecoveryFinalized() {
    if (await this.incompleteActivation()) throw new Error('recovery_activated_requires_finalization');
  }
  private async recoverySession(s: SyncSaved, interactive: boolean) {
    const environment = await this.environment(s.endpoint);
    if (
      environment.serverId !== s.profile?.pin.serverId ||
      (s.discovered &&
        canonicalStringify(environment.oidc) !==
          canonicalStringify(s.discovered.oidc))
    )
      throw new Error("server_configuration_changed");
    let session = this.cachedSession;
    if (
      !session ||
      !session.expiresAt ||
      session.expiresAt <= Date.now() + 30000
    ) {
      if (!interactive) throw new Error("interaction_required");
      session = await this.options.login(environment);
    }
    if (
      !s.owner ||
      session.issuer !== environment.oidc.issuer ||
      !s.identity ||
      session.issuer !== s.identity.issuer ||
      session.subject !== s.identity.subject
    )
      throw new Error("account_mismatch");
    this.cachedSession = session;
    return session;
  }
  private async recoveryControl(
    s: SyncSaved,
    action: string,
    value: unknown,
    interactive: boolean,
  ) {
    const session = await this.recoverySession(s, interactive);
    const response = await syncFetchText(
      `${s.endpoint}/v1/vaults/${s.profile!.pin.vaultId}/${action}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + session.accessToken,
        },
        body: canonicalStringify(value),
      },
    );
    const result = decodeCanonical(
      encodeUtf8(response.text),
      4194304,
      100000,
    ) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(String(result.error ?? "temporary_failure"));
    return result;
  }
  private async recoveryAttempt(s: SyncSaved) {
    if (
      !(
        await this.options.db.read(
          "SELECT name FROM sqlite_master WHERE name='recovery_journal'",
        )
      ).length
    )
      return null;
    return (
      (
        await this.options.db.read(
          "SELECT * FROM recovery_journal WHERE vault_id=? AND from_epoch=? ORDER BY rowid DESC LIMIT 1",
          [s.profile!.pin.vaultId, s.profile!.pin.serverEpoch],
        )
      )[0] ?? null
    );
  }
  async prepareServerRecovery(confirmed: boolean) {
    if (!confirmed) throw new Error("epoch_anchor_confirmation_required");
    const backup = this.options.epochBackup;
    if (!backup) throw new Error("anchor_backup_unavailable");
    if (await this.incompleteActivation())
      throw new Error("recovery_activated_requires_finalization");
    this.coordinator.cancel();
    await this.pause(true);
    await this.coordinator.cancelAndWait();
    const s = await this.saved(),
      device = this.device(s);
    let journal = await this.recoveryAttempt(s);
    const environment = await this.environment(s.endpoint);
    await this.options.db.run(
      (function* (): SqlWorkflow {
        yield {
          sql: `CREATE TABLE IF NOT EXISTS recovery_owner_requests(from_epoch TEXT NOT NULL,to_epoch TEXT NOT NULL,
        restore_id TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL,recovery_json TEXT,PRIMARY KEY(from_epoch,to_epoch))`,
        };
      })(),
    );
    if (!journal) {
      let [reserved] = await this.options.db.read(
        "SELECT * FROM recovery_owner_requests WHERE from_epoch=? AND to_epoch=?",
        [device.profile.pin.serverEpoch, environment.serverEpoch],
      );
      if (!reserved) {
        const response = await this.recoveryControl(
          s,
          "epoch-recovery-challenge",
          {
            fromEpoch: device.profile.pin.serverEpoch,
            authorityPublicKey: device.profile.pin.authorityPublicKey,
          },
          true,
        );
        const authorization = await authorizeEpochRecovery(
          device,
          response.challenge as Parameters<typeof authorizeEpochRecovery>[1],
          true,
        );
        await this.options.db.run(
          (function* (): SqlWorkflow {
            yield {
              sql: "INSERT INTO recovery_owner_requests VALUES(?,?,?,?,?)",
              params: [
                device.profile.pin.serverEpoch,
                environment.serverEpoch,
                authorization.restoreId,
                canonicalStringify(authorization),
                response.recovery
                  ? canonicalStringify(response.recovery)
                  : null,
              ],
            };
          })(),
        );
        [reserved] = await this.options.db.read(
          "SELECT * FROM recovery_owner_requests WHERE restore_id=?",
          [authorization.restoreId],
        );
      }
      const authorization: EpochRecoveryAuthorization = JSON.parse(
        String(reserved.authorization_json),
      );
      const accepted = await this.recoveryControl(
        s,
        "epoch-recovery-authorize",
        { authorization, knownGrants: device.profile.grants },
        true,
      );
      if (
        canonicalStringify(accepted.authorization) !==
        canonicalStringify(authorization)
      )
        throw new Error("activation_mismatch");
      await prepareAnchorArchive({
        db: this.options.db,
        device,
        acceptedAuthorization: authorization,
        confirmed: true,
        backup: backup.create,
        inspectBackup: backup.inspect,
      });
      journal = await this.recoveryAttempt(s);
    }
    const restoreId = String(journal!.restore_id);
    await this.options.db.run(
      planAnchorBaseline(restoreId, () => this.crypto().uuid()),
    );
    const preparation = {
      db: this.options.db,
      deviceA: device,
      sodium: this.options.sodium,
      restoreId,
    };
    const [reserved] = await this.options.db.read(
      "SELECT recovery_json FROM recovery_owner_requests WHERE restore_id=?",
      [restoreId],
    );
    if (!reserved) throw new Error("recovery_artifact_missing");
    const prepared = await prepareOperationalB({
      ...preparation,
      previousRecovery: reserved.recovery_json
        ? JSON.parse(String(reserved.recovery_json))
        : null,
    });
    return prepared.code
      ? { code: prepared.code }
      : this.stageRecovery(s, preparation);
  }
  async confirmServerRecovery(code: string) {
    const s = await this.saved(),
      journal = await this.recoveryAttempt(s);
    if (!journal) throw new Error("recovery_attempt_missing");
    const preparation = {
      db: this.options.db,
      deviceA: this.device(s),
      sodium: this.options.sodium,
      restoreId: String(journal.restore_id),
    };
    await confirmOperationalBRecovery(preparation, code);
    return this.stageRecovery(s, preparation);
  }
  private async stageRecovery(
    s: SyncSaved,
    preparation: {
      db: LocalSyncDatabase;
      deviceA: DeviceProvisioning;
      sodium: TransportSodium;
      restoreId: string;
    },
  ) {
    const previousRows = await this.options.db.read(
      `SELECT transition_json FROM recovery_b_saga b JOIN recovery_journal j USING(restore_id) WHERE j.vault_id=? AND j.to_epoch=?`,
      [s.profile!.pin.vaultId, s.profile!.pin.serverEpoch],
    );
    const previous: EpochTransition | null = previousRows[0]?.transition_json
      ? JSON.parse(String(previousRows[0].transition_json))
      : null;
    await stageOperationalB({
      ...preparation,
      previousTrustedTransition: previous,
      transport: (action, r) =>
        this.recoveryControl(s, "epoch-staging-" + action, r, true),
    });
    return this.status();
  }
  private async activationOptions(
    s: SyncSaved,
    id: string,
    interactive: boolean,
  ): Promise<AnchorActivationOptions> {
    const backup = this.options.epochBackup;
    if (!backup) throw new Error("anchor_backup_unavailable");
    const [journal] = await this.options.db.read(
      "SELECT * FROM recovery_journal WHERE restore_id=?",
      [id],
    );
    return {
      db: this.options.db,
      deviceA: new DeviceProvisioning(
        JSON.parse(String(journal.profile_a_json)),
        this.options.secrets,
        this.crypto(),
      ),
      sodium: this.options.sodium,
      restoreId: id,
      dialect: this.options.dialect,
      endpoint: s.endpoint,
      transport: (action, r) =>
        this.recoveryControl(
          s,
          action === "activate"
            ? "epoch-activation"
            : "epoch-activation-status",
          r,
          interactive,
        ),
      inspectBackup: backup.inspect,
      checkpoint: backup.create,
      inspectCheckpoint: (path) => backup.inspectCheckpoint(path, id),
      saveProfile: async (profile) => {
        const [prepared] = await this.options.db.read(
          "SELECT recovery_json FROM recovery_b_saga WHERE restore_id=?",
          [id],
        );
        const next: SyncSaved = {
          ...s,
          profile,
          phase: "bound",
          recoveryVersion: JSON.parse(String(prepared.recovery_json)).envelope
            .recoveryVersion,
          discovered: s.discovered
            ? { ...s.discovered, serverEpoch: profile.pin.serverEpoch }
            : undefined,
        };
        delete next.request;
        delete next.pendingRecovery;
        delete next.pendingKeyCheckpoint;
        await this.options.storage.save(next);
      },
      loadProfile: async () =>
        (await this.options.storage.load())?.profile ?? null,
      firstPull: async (device) => {
        const current = (await this.options.storage.load())!;
        const session = await this.session(current, interactive);
        const engine = new ManualSync(
          this.options.db,
          device,
          this.options.sodium,
          this.options.dialect,
          s.endpoint,
          fetchSyncHttp(s.endpoint),
        );
        await engine.pull(session.accessToken);
      },
    };
  }
  async activateServerRecovery(confirmed: boolean) {
    await this.coordinator.cancelAndWait();
    const s = await this.saved(),
      pending = await this.incompleteActivation(),
      journal = await this.recoveryAttempt(s);
    const id = String(pending?.restore_id ?? journal?.restore_id ?? "");
    if (!id) throw new Error("recovery_attempt_missing");
    await requestAnchorActivation(
      await this.activationOptions(s, id, true),
      confirmed,
    );
    this.coordinator.error = undefined;
    this.coordinator.request("foreground");
    return this.status();
  }
  /** Native startup calls this before subscribing to foreground. It never reserves new consent. */
  async resumeRecoveryOnStartup() {
    const pending = await this.incompleteActivation();
    if (!pending) return;
    await this.coordinator.cancelAndWait();
    await resumeAnchorActivation(
      await this.activationOptions(
        await this.saved(),
        String(pending.restore_id),
        false,
      ),
    );
    this.coordinator.error = undefined;
  }
  localWriteCommitted() {
    this.coordinator.request('local-write');
  }
  setForeground(active: boolean) {
    this.coordinator.setForeground(active);
  }
  subscribe(listener: () => void) {
    return this.coordinator.subscribe(listener);
  }

  private crypto() {
    return new ProvisioningCrypto(this.options.sodium);
  }
  async configure(endpoint: string) {
    await this.requireRecoveryFinalized();
    const saved = await this.options.storage.load();
    const normalized = normalizeEndpoint(endpoint, this.options.allowLocalDevelopment);
    if (saved?.profile && normalized !== saved.endpoint)
      throw new Error('Desconecte com revisão antes de trocar o servidor.');
    const [binding] = await this.options.db.read('SELECT endpoint FROM sync_bindings WHERE binding_id=(SELECT binding_id FROM sync_local_state WHERE id=1)');
    if (binding && binding.endpoint !== normalized)
      throw new Error('Esta base está vinculada a outro servidor. Troca direta indisponível; preserve a base e as pendências para uma migração revisada.');
    const discovered = await this.environment(normalized);
    this.cachedSession = undefined;
    await this.options.storage.save({ ...saved, endpoint: normalized, discovered });
    return this.status();
  }
  async environment(
    endpoint?: string,
    signal?: AbortSignal,
  ): Promise<SyncEnvironment> {
    const origin = normalizeEndpoint(
      endpoint ??
        (await this.options.storage.load())?.endpoint ??
        (this.options.defaultEndpoint ?? ''),
      this.options.allowLocalDevelopment,
    );
    const response = await syncFetchText(
      origin + '/v1/environment',
      {},
      signal,
    );
    if (!response.ok)
      throw new Error('Servidor indisponível. O banco continua local.');
    const text = response.text;
    if (text.length > 65536) throw new Error('Invalid environment.');
    const e = decodeCanonical(encodeUtf8(text), 65536) as SyncEnvironment;
    assertCompatibleEnvironment(e);
    if ((e.audience !== undefined && e.audience !== 'lionpocket-sync-api') || (e.cryptoSuites !== undefined && (!Array.isArray(e.cryptoSuites) || e.cryptoSuites.length !== 1 || e.cryptoSuites[0] !== 'lp-sodium-v1'))) throw new Error('unsupported_capability');
    assertUuid(e.serverId, '4');
    assertUuid(e.serverEpoch, '4');
    if (!e.financialSyncEnabled || !e.oidc || !Array.isArray(e.entityScopes))
      throw new Error('Este servidor não oferece sincronização financeira compatível.');
    const issuer = new URL(e.oidc.issuer);
    if (issuer.username || issuer.password || issuer.search || issuer.hash ||
        (issuer.protocol !== 'https:' && !(this.options.allowLocalDevelopment && issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname))))
      throw new Error('Autenticação HTTPS inválida.');
    if (![e.oidc.desktopClientId, e.oidc.androidClientId].every(v => typeof v === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(v)) ||
        e.oidc.desktopRedirect !== 'http://127.0.0.1:18761/callback' ||
        !['com.lionpocketmobile:/callback', 'com.lionpocketmobile.beta:/callback', ...(this.options.allowLocalDevelopment ? ['com.lionpocketmobile.syncdev:/callback'] : [])].includes(e.oidc.androidRedirect))
      throw new Error('Configuração de login incompatível.');
    return e;
  }
  private async saved() {
    const s = await this.options.storage.load();
    if (!s) {
      if (!this.options.defaultEndpoint) throw new Error('Configure um servidor HTTPS antes de conectar.');
      await this.configure(this.options.defaultEndpoint);
      return (await this.options.storage.load())!;
    }
    return s;
  }
  private device(saved: SyncSaved) {
    if (!saved.profile) throw new Error('Crie ou conecte um cofre.');
    return new DeviceProvisioning(
      saved.profile,
      this.options.secrets,
      this.crypto(),
    );
  }
  private async session(
    saved: SyncSaved,
    interactive = true,
    signal?: AbortSignal,
  ) {
    const environment = await this.environment(saved.endpoint, signal);
    if (
      saved.profile &&
      (environment.serverId !== saved.profile.pin.serverId ||
        environment.serverEpoch !== saved.profile.pin.serverEpoch)
    )
      throw new Error('epoch_changed');
    if (saved.discovered && (saved.discovered.serverId !== environment.serverId ||
        saved.discovered.serverEpoch !== environment.serverEpoch ||
        canonicalStringify(saved.discovered.oidc) !== canonicalStringify(environment.oidc)))
      throw new Error('server_configuration_changed');
    let session = this.cachedSession;
    if (
      !session ||
      !session.expiresAt ||
      session.expiresAt <= Date.now() + 30000
    ) {
      this.cachedSession = undefined;
      if (!interactive) throw new Error('interaction_required');
      session = await this.options.login(environment);
    }
    if (
      session.issuer !== environment.oidc.issuer ||
      (saved.identity &&
        (session.issuer !== saved.identity.issuer ||
          session.subject !== saved.identity.subject))
    )
      throw new Error('account_mismatch');
    saved.identity = { issuer: session.issuer, subject: session.subject };
    this.cachedSession = session;
    return session;
  }
  private async control(
    saved: SyncSaved,
    action: string,
    value: unknown,
    session: SyncSession,
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
    await this.requireRecoveryFinalized();
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
      await this.finishCreation(s);
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
    await this.finishCreation(s);
    return this.status();
  }
  private async finishCreation(s: SyncSaved) {
    if (this.options.requireRecoveryConfirmation !== false && !s.recoveryVersion) {
      s.phase = 'recovery';
      await this.options.storage.save(s);
    } else await this.bind(s, false);
  }
  invitation(saved: SyncSaved): string {
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
    normalizeEndpoint(parsed.endpoint, this.options.allowLocalDevelopment);
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
    await this.requireRecoveryFinalized();
    const invite = await this.inspectInvitation(invitation);
    const selected = await this.options.storage.load();
    if (selected?.endpoint && selected.endpoint !== invite.endpoint) throw new Error('O convite pertence a outro servidor. Confira a URL antes de continuar.');
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
  private async bind(s: SyncSaved, joining: boolean) {
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
    this.coordinator.request('foreground');
  }
  async receive() {
    await this.requireRecoveryFinalized();
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
  private async engine(s: SyncSaved, signal?: AbortSignal) {
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
      fetchSyncHttp(s.endpoint, signal),
      () => !signal?.aborted,
    );
  }
  async sync() {
    await this.coordinator.request('manual');
    return this.status();
  }
  private async syncCycle(interactive: boolean, signal: AbortSignal) {
    const s = await this.saved();
    try {
      const session = await this.session(s, interactive, signal);
      if (signal.aborted) throw new Error('foreground_inactive');
      const engine = await this.engine(s, signal);
      await engine.sync(session.accessToken);
      s.profile = engine.device.profile;
      await this.options.storage.save(s);
    } catch (error) {
      if (
        error instanceof Error &&
        ['unauthenticated', 'forbidden', 'device_revoked'].includes(
          error.message,
        )
      )
        this.cachedSession = undefined;
      throw error;
    }
  }
  async requests() {
    const s = await this.saved(),
      session = await this.session(s);
    return this.control(s, 'pairing-list', {}, session) as unknown as Promise<{
      requests: PairingRequest[];
    }>;
  }
  async approve(deviceId: string, fingerprint: string) {
    await this.requireRecoveryFinalized();
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
    s: SyncSaved,
    session: SyncSession,
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
      ) !== (d.profile.activeKeyVersion ?? d.profile.pin.keyVersion)
    )
      throw new Error('recovery_stale');
    if (
      s.pendingKeyCheckpoint &&
      s.pendingKeyCheckpoint.keyVersion <= (d.profile.activeKeyVersion ?? d.profile.pin.keyVersion) &&
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
    await this.requireRecoveryFinalized();
    const s = await this.saved();
    await this.rotate(s, await this.session(s));
    return this.status();
  }
  async revoke(deviceId: string, confirmedDeviceId: string) {
    await this.requireRecoveryFinalized();
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
    await this.requireRecoveryFinalized();
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
    await this.requireRecoveryFinalized();
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
    if (s.phase === 'recovery') await this.bind(s, false);
    return this.status();
  }
  async recover(
    invitation: string,
    confirmedFingerprint: string,
    code: string,
  ) {
    await this.requireRecoveryFinalized();
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
    await this.requireRecoveryFinalized();
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
    this.coordinator.request('foreground');
    return this.status();
  }
  async pause(paused: boolean) {
    if (!paused && await this.incompleteActivation()) throw new Error('recovery_activated_requires_finalization');
    await this.options.db.run(
      (function* () {
        yield {
          sql: 'UPDATE sync_control SET paused=? WHERE id=1',
          params: [paused ? 1 : 0],
        };
      })(),
    );
    if (paused) this.coordinator.cancel();
    else this.coordinator.request('foreground');
    return this.status();
  }
  async seriesReviews() {
    const result: LegacySeriesReview[] = [];
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
      if (!row) continue;
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
        startingInstallment: Number(row.starting_installment ?? 1),
        anchorToActual: !!row.anchor_to_actual,
        slots: slots.map((t) => ({
          localId: String(t.id),
          description: String(t.description),
          status: String(t.status),
          currentDate: String(
            t.occurrence_date ??
              (type === 'recurring' ? t.purchase_date : null) ??
              t.due_date,
          ),
          dueDate: String(t.due_date),
          originalDate: t.occurrence_date ? String(t.occurrence_date) : null,
          dateNeedsReview:
            !t.occurrence_date &&
            ((!t.purchase_date && type === 'recurring') ||
              (!!t.updated_at && t.updated_at !== t.created_at) ||
              (type === 'installmentPurchase' &&
                !!row.updated_at &&
                row.updated_at !== row.created_at)),
          positionNeedsReview:
            type === 'installmentPurchase' &&
            ((!!row.updated_at && row.updated_at !== row.created_at) ||
              (!!t.updated_at && t.updated_at !== t.created_at)),
          installmentNumber:
            t.installment_number == null ? null : Number(t.installment_number),
          plannedAmountCents: Number(t.planned_cents ?? t.planned_amount_cents),
          actualAmountCents:
            t.actual_cents == null && t.actual_amount_cents == null
              ? null
              : Number(t.actual_cents ?? t.actual_amount_cents),
          settledDate: t.settled_date ? String(t.settled_date) : null,
          deletedAt: t.deleted_at ? String(t.deleted_at) : null,
        })),
      });
    }
    return result.map((series) => {
      const groups = seriesDecisionGroups(series);
      const suggestedSlots = initialSeriesChoices(series);
      const autoReason = groups.length
        ? seriesPendingReason(series)
        : seriesReviewError(series, suggestedSlots);
      return {
        ...series,
        suggestedSlots,
        autoReason,
        autoResolvable: autoReason === null,
      };
    });
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
    this.localWriteCommitted();
    return this.status();
  }
  async reviewSuggestedSeries(confirm: boolean) {
    if (!confirm)
      throw new Error('Confirme o uso dos dados atuais como base.');
    const reviews = await this.seriesReviews(),
      automatic = reviews.filter((review) => review.autoResolvable);
    for (const review of automatic)
      await this.options.db.run(
        reviewLegacySeries(
          review.entityType,
          review.localId,
          review.suggestedSlots,
          () => this.crypto().uuid(),
        ),
      );
    if (automatic.length) this.localWriteCommitted();
    return {
      resolved: automatic.length,
      remaining: reviews.length - automatic.length,
      status: await this.status(),
    };
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
    this.localWriteCommitted();
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
    this.localWriteCommitted();
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
    this.localWriteCommitted();
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
    this.localWriteCommitted();
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
    const reviews = await this.options.db.read(
      "SELECT * FROM sync_review WHERE reason NOT IN ('active_key_version','reemission_provenance','legacy_import_review_provenance') AND reason NOT LIKE 'import_receipt:%'",
    );
    const quarantine = await this.options.db.read(
      "SELECT commit_id,last_error FROM sync_inbox WHERE state='quarantined'",
    );
    const blocked = await this.options.db.read(
      "SELECT commit_id FROM sync_outbox WHERE state='blocked' AND COALESCE(last_error,'') NOT IN ('key_rotated','remote_accepted_before_rotation')",
    );
    const activation = await this.incompleteActivation();
    let recoveryPhase: string | null = activation
      ? String(activation.phase)
      : null;
    if (
      !recoveryPhase &&
      saved?.profile &&
      (
        await this.options.db.read(
          "SELECT name FROM sqlite_master WHERE name='recovery_b_saga'",
        )
      ).length
    ) {
      const hasActivation = (await this.options.db.read("SELECT name FROM sqlite_master WHERE name='recovery_activation_saga'")).length > 0;
      const rows = await this.options.db.read(
        hasActivation ?
          `SELECT b.phase,a.phase AS activation_phase FROM recovery_b_saga b JOIN recovery_journal j USING(restore_id)
        LEFT JOIN recovery_activation_saga a USING(restore_id) WHERE j.vault_id=? ORDER BY j.rowid DESC LIMIT 1` :
          `SELECT b.phase FROM recovery_b_saga b JOIN recovery_journal j USING(restore_id) WHERE j.vault_id=? ORDER BY j.rowid DESC LIMIT 1`,
          [saved.profile.pin.vaultId],
        );
      recoveryPhase = rows[0]
        ? String(rows[0].activation_phase ?? rows[0].phase)
        : null;
    }
    const error = this.coordinator.error;
    // A completed recovery of the selected profile is historical after another server restore.
    if (recoveryPhase === 'recovered' && error === 'epoch_changed') recoveryPhase = null;
    const accountAction =
      [
        'interaction_required',
        'unauthenticated',
        'account_mismatch',
        'forbidden',
        'device_revoked',
        'secret_unavailable',
        'signing_secret_unavailable',
        'key_mismatch',
        'key_version_mismatch',
      ].includes(error ?? '') ||
      /secret|cofre|vault.*(unavailable|locked)|key.*(unavailable|locked)/i.test(
        error ?? '',
      );
    const needsReview = !!(
      ['epoch_changed', 'unsupported_version', 'unsupported_capability', 'server_configuration_changed'].includes(error ?? '') ||
      reviews.length ||
      quarantine.length ||
      sync?.conflicts.length ||
      blocked.length ||
      bootstrap?.state === 'joining_review' ||
      (state.mode === 'disabled' && state.binding_id)
    );
    const activity = this.coordinator.running
      ? 'syncing'
      : control.paused
        ? 'paused'
        : accountAction
          ? 'action-required'
          : needsReview
            ? 'review'
            : error && error !== 'foreground_inactive'
              ? 'unavailable'
              : sync?.pending
                ? 'pending'
                : (saved?.discovered && !saved.phase) || (saved?.phase && saved.phase !== 'bound')
                  ? 'configuring'
                : saved?.phase !== 'bound'
                  ? 'local'
                  : this.coordinator.lastCompletedAt
                    ? 'synced'
                    : 'ready';
    return {
      recoveryPhase,
      anchorRecoveryAvailable: !!this.options.epochBackup && !!saved?.owner,
      activity: (activation ? 'action-required' : activity) as SyncActivity,
      discovered: saved?.discovered ?? null,
      compatibilityMessage: ['unsupported_version', 'unsupported_capability'].includes(error ?? '')
        ? 'Atualização necessária: cliente e servidor incompatíveis. Banco local e pendências preservados; nenhum envio realizado.'
        : error === 'epoch_changed'
          ? 'O histórico do servidor mudou. Este aparelho ainda precisa ser reconectado após a recuperação do servidor. Seus dados e alterações locais estão preservados.'
          : error === 'server_configuration_changed'
            ? 'A configuração do servidor mudou. Revise o servidor antes de entrar novamente; banco local e pendências preservados.'
            : null,
      lastCompletedAt: this.coordinator.lastCompletedAt ?? null,
      restoreReview: state.mode === 'disabled' && !!state.binding_id,
      activeKeyVersion: saved?.profile?.activeKeyVersion ?? saved?.profile?.pin.keyVersion ?? 1,
      recoveryVersion: saved?.recoveryVersion ?? '0',
      endpoint: saved?.endpoint ?? (this.options.defaultEndpoint ?? ''),
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
      reviews,
      quarantine,
      mode: String(state.mode),
    };
  }
}
export type SeriesReview = Awaited<
  ReturnType<SyncController['seriesReviews']>
>[number];
export type CatalogReview = Awaited<
  ReturnType<SyncController['catalogReviews']>
>[number];
export type SyncStatus = Awaited<ReturnType<SyncController['status']>>;

export type SyncActivity =
  | 'configuring'
  | 'syncing'
  | 'paused'
  | 'action-required'
  | 'review'
  | 'unavailable'
  | 'pending'
  | 'local'
  | 'synced'
  | 'ready';
export const syncActivityLabel: Record<SyncActivity, string> = {
  configuring: 'Configurando',
  syncing: 'Sincronizando…',
  paused: 'Sync pausado',
  'action-required': 'É necessário entrar novamente ou desbloquear as chaves',
  review: 'Revisão/conflito necessário',
  unavailable: 'Offline ou servidor indisponível',
  pending: 'Alterações pendentes',
  local: 'Somente neste aparelho',
  synced: 'Sincronizado',
  ready: 'Pronto para sincronizar',
};
