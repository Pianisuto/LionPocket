import { SYNC_CONTROL_VERSION } from './compatibility';
import { syncFetchText } from './network';
import { acceptKeyCheckpoints } from './security';
import { reissueForKeyVersion } from './reemission';
import {
  activeDevice,
  assertCommitReceipt,
  assertDecimal64,
  assertManualTransactionRevision, assertFinancialRevision, assertSupportedRevision,
  assertUuid,
  canonicalStringify,
  commitSigningInput,
  decodeCanonical,
  decodeCommit,
  encodeUtf8,
  exactObject,
  operationAssociatedData,
  sameScope,
  transportLimits,
  validateGrantChain,
  type ChangesPage,
  type CommitEnvelope,
  type CommitReceipt,
  type UnsignedCommit,
} from '@lionpocket/sync-protocol';
import {
  DeviceProvisioning,
  type RegistryResponse,
  type ProvisioningSodium,
} from './provisioning';
import {
  acknowledge,
  applyCommit,
  compareDecimal,
  persistPrepared,
  receivePage,
  rejectResolution,
  sql,
  updateRegistry,
  type LocalSyncDatabase,
  type ProjectionDialect,
  type DecodedOperation,
} from './transport-state';
import { captureFinancial } from './financial';
import { incrementDecimal64, type SqlWorkflow } from './manual';

export interface TransportSodium extends ProvisioningSodium {
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    ad: string,
    nsec: null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    nsec: null,
    ciphertext: Uint8Array,
    ad: string,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array | null;
}
export interface SyncHttp {
  request(
    target: string,
    body: string,
    proof: string,
    token: string,
  ): Promise<unknown>;
}
export class SyncHttpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function fetchSyncHttp(endpoint: string, signal?: AbortSignal): SyncHttp {
  return {
    async request(target, body, proof, token) {
      const response = await syncFetchText(endpoint + target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-lionpocket-proof': proof,
          'x-lionpocket-control-version': String(SYNC_CONTROL_VERSION),
        },
        body,
      }, signal);
      const text = response.text;
      const result = decodeCanonical(encodeUtf8(text), 4194304, 100000);
      if (!response.ok)
        throw new SyncHttpError(
          String((result as { error?: string }).error ?? 'temporary_failure'),
        );
      return result;
    },
  };
}
function* mark(
  commitId: string,
  state: string,
  error: string | null,
): SqlWorkflow {
  yield sql('UPDATE sync_outbox SET state=?,last_error=? WHERE commit_id=?', [
    state,
    error,
    commitId,
  ]);
}
function* quarantine(commitId: string, error: string): SqlWorkflow {
  yield sql(
    "UPDATE sync_inbox SET state='quarantined',last_error=? WHERE commit_id=?",
    [error, commitId],
  );
}
function* sendFailure(
  commitId: string,
  state: string,
  error: string,
  dialect: ProjectionDialect,
  uuid: () => string,
): SqlWorkflow {
  yield* mark(commitId, state, error);
  // A rejected draft must leave the active DAG in the same transaction that
  // makes its outbox ineligible for retries, including after process crashes.
  if (error === 'heads_changed')
    yield* rejectResolution(commitId, dialect, uuid);
}
function* appliedCursor(): SqlWorkflow {
  const [state] = yield sql('SELECT * FROM sync_local_state WHERE id=1');
  let cursor = String(state.applied_cursor);
  const rows = yield sql(
    'SELECT log_position,state FROM sync_inbox ORDER BY length(log_position),log_position',
  );
  for (const row of rows) {
    if (compareDecimal(String(row.log_position), cursor) <= 0) continue;
    if (
      row.log_position !== incrementDecimal64(cursor) ||
      row.state !== 'applied'
    )
      break;
    cursor = String(row.log_position);
  }
  yield sql('UPDATE sync_local_state SET applied_cursor=? WHERE id=1', [
    cursor,
  ]);
}
/** One instance per bank; no credentials, DEK or private keys are persisted here. */
export class ManualSync {
  private running = false;
  constructor(
    readonly db: LocalSyncDatabase,
    readonly device: DeviceProvisioning,
    readonly sodium: TransportSodium,
    readonly dialect: ProjectionDialect,
    readonly endpoint: string,
    readonly http: SyncHttp = fetchSyncHttp(endpoint),
    readonly canTransport: () => boolean = () => true,
  ) {}
  private async state() {
    const [state] = await this.db.read(
      'SELECT * FROM sync_local_state WHERE id=1',
    );
    if (
      !['synthetic_manual','financial'].includes(String(state.mode)) ||
      !state.binding_id ||
      state.device_id !== this.device.profile.deviceId
    )
      throw new Error('sync_disabled');
    const [binding] = await this.db.read(
      'SELECT * FROM sync_bindings WHERE binding_id=?',
      [String(state.binding_id)],
    );
    if (
      !binding ||
      binding.endpoint !== this.endpoint ||
      binding.pin_json !== canonicalStringify(this.device.profile.pin)
    )
      throw new Error('binding_changed');
    return state;
  }
  private async request(action: string, value: unknown) {
    if (!this.canTransport()) throw new Error('foreground_inactive');
    const body = canonicalStringify(value),
      target = `/v2/devices/vaults/${this.device.profile.pin.vaultId}/${action}`;
    const proof = await this.device.proof(
      'POST',
      target,
      this.endpoint,
      body,
      '',
    );
    if (!this.canTransport()) throw new Error('foreground_inactive');
    return this.http.request(
      target,
      body,
      this.device.crypto.encode(encodeUtf8(canonicalStringify(proof))),
      '',
    );
  }
  async prepare(commitId: string): Promise<string> {
    const [row] = await this.db.read(
      'SELECT * FROM sync_outbox WHERE commit_id=?',
      [commitId],
    );
    if (!row) throw new Error('outbox_missing');
    if (row.envelope_json !== null) return String(row.envelope_json);
    const state = await this.state();
    const registry = validateGrantChain(
      this.device.profile.grants,
      this.device.profile.pin,
      this.device.crypto,
      this.device.profile.checkpoint,
    );
    activeDevice(registry.devices, this.device.profile.deviceId);
    const pending = decodeCanonical(
      encodeUtf8(String(row.payload_json)),
      transportLimits.commitBytes,
    ) as {
      commitId: string;
      operations: (DecodedOperation & { expectedHeads?: string[] })[];
    };
    const seed = await this.device.secrets.load(
        this.device.scope('signingSeed'),
      ),
      key = await this.device.secrets.load(this.device.scope('dataKey'));
    try {
      if (!seed || !key) throw new Error('secret_unavailable');
      const pair = this.sodium.crypto_sign_seed_keypair(seed);
      const publicKey = this.device.crypto.encode(pair.publicKey);
      this.device.crypto.erase(pair.privateKey);
      if (
        publicKey !== this.device.profile.signingPublicKey ||
        key.length !== 32
      )
        throw new Error('key_mismatch');
      const { serverId, serverEpoch, vaultId } = this.device.profile.pin;
      const unsigned: UnsignedCommit = {
        protocolVersion: 1,
        serverId,
        serverEpoch,
        vaultId,
        deviceId: this.device.profile.deviceId,
        deviceSeq: incrementDecimal64(String(state.device_seq)),
        commitId,
        keyVersion: this.device.profile.activeKeyVersion ?? this.device.profile.pin.keyVersion,
        deviceRegistryVersion: registry.checkpoint.version,
        cryptoSuite: 'lp-sodium-v1',
        operations: pending.operations.map((op) => ({
          opId: op.opId,
          objectId: op.objectId,
          parents: op.parents,
          ...(op.expectedHeads ? { expectedHeads: op.expectedHeads } : {}),
          nonce: this.device.crypto.encode(this.sodium.randombytes_buf(24)),
          ciphertext: '',
        })),
      };
      for (let i = 0; i < unsigned.operations.length; i++) {
        assertSupportedRevision(pending.operations[i].revision, state.mode === 'financial');
        const bytes = encodeUtf8(
          canonicalStringify(pending.operations[i].revision),
        );
        try {
          unsigned.operations[i].ciphertext = this.device.crypto.encode(
            this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
              bytes,
              operationAssociatedData(unsigned, i),
              null,
              this.device.crypto.decode(unsigned.operations[i].nonce),
              key,
            ),
          );
        } finally {
          this.device.crypto.erase(bytes);
        }
      }
      const envelope: CommitEnvelope = {
        ...unsigned,
        signature: this.device.crypto.sign(commitSigningInput(unsigned), seed),
      };
      decodeCommit(encodeUtf8(canonicalStringify(envelope)));
      await this.db.run(
        persistPrepared(
          commitId,
          envelope,
          this.device.crypto.hash(canonicalStringify(envelope)),
          String(state.device_seq),
        ),
      );
      return String(
        (
          await this.db.read(
            'SELECT envelope_json FROM sync_outbox WHERE commit_id=?',
            [commitId],
          )
        )[0].envelope_json,
      );
    } finally {
      if (seed) this.device.crypto.erase(seed);
      if (key) this.device.crypto.erase(key);
    }
  }
  private receipt(value: unknown, envelope: CommitEnvelope): CommitReceipt {
    assertCommitReceipt(value);
    const r = exactObject(value, [
      'serverId',
      'serverEpoch',
      'vaultId',
      'commitId',
      'deviceId',
      'deviceSeq',
      'result',
      'logPosition',
      'acceptedRegistryVersion',
      'envelopeSha256',
      'heads',
    ]);
    sameScope(r as unknown as CommitReceipt, envelope);
    if (
      r.commitId !== envelope.commitId ||
      r.deviceId !== envelope.deviceId ||
      r.deviceSeq !== envelope.deviceSeq ||
      r.result !== 'accepted' ||
      r.envelopeSha256 !== this.device.crypto.hash(canonicalStringify(envelope))
    )
      throw new Error('receipt_mismatch');
    assertDecimal64(r.logPosition, true);
    assertDecimal64(r.acceptedRegistryVersion, true);
    if (
      compareDecimal(
        String(r.acceptedRegistryVersion),
        envelope.deviceRegistryVersion,
      ) < 0 ||
      compareDecimal(
        String(r.acceptedRegistryVersion),
        this.device.profile.checkpoint!.version,
      ) > 0
    )
      throw new Error('registry_order');
    if (!Array.isArray(r.heads)) throw new Error('receipt_mismatch');
    const expected = [
      ...new Set(envelope.operations.map((o) => o.objectId)),
    ].sort();
    if (r.heads.length !== expected.length) throw new Error('receipt_mismatch');
    r.heads.forEach((item, index) => {
      const h = exactObject(item, ['objectId', 'revisionIds']);
      if (
        h.objectId !== expected[index] ||
        !Array.isArray(h.revisionIds) ||
        !h.revisionIds.length
      )
        throw new Error('receipt_mismatch');
      const ids = h.revisionIds as string[];
      ids.forEach((id: string, i: number) => {
        assertUuid(id, '4');
        if (i && ids[i - 1] >= id) throw new Error('receipt_mismatch');
      });
    });
    return r as unknown as CommitReceipt;
  }
  private page(value: unknown, state: Record<string, unknown>): ChangesPage {
    const p = exactObject(value, [
      'serverId',
      'serverEpoch',
      'vaultId',
      'bindingId',
      'upperBound',
      'nextCursor',
      'hasMore',
      'commits',
    ]);
    sameScope(p as unknown as ChangesPage, this.device.profile.pin);
    assertDecimal64(p.upperBound);
    assertDecimal64(p.nextCursor);
    if (
      p.bindingId !== state.binding_id ||
      typeof p.hasMore !== 'boolean' ||
      !Array.isArray(p.commits) ||
      p.commits.length > 100 ||
      compareDecimal(String(p.upperBound), String(state.received_cursor)) < 0 ||
      (state.pull_upper_bound !== null &&
        p.upperBound !== state.pull_upper_bound)
    )
      throw new Error('cursor_mismatch');
    let prior = String(state.received_cursor);
    for (const item of p.commits) {
      const entry = exactObject(item, [
        'logPosition',
        'acceptedRegistryVersion',
        'envelope',
      ]);
      assertDecimal64(entry.logPosition, true);
      assertDecimal64(entry.acceptedRegistryVersion, true);
      if (
        entry.logPosition !== incrementDecimal64(prior) ||
        compareDecimal(String(entry.logPosition), String(p.upperBound)) > 0
      )
        throw new Error('cursor_mismatch');
      prior = String(entry.logPosition);
      // Preserve unknown versions in durable quarantine, but validate their routing IDs now.
      const e = entry.envelope as CommitEnvelope;
      if (!e || typeof e !== 'object') throw new Error('invalid_envelope');
      assertUuid(e.commitId, '4');
      sameScope(e, this.device.profile.pin);
    }
    if (
      p.nextCursor !== prior ||
      p.hasMore !== compareDecimal(prior, String(p.upperBound)) < 0 ||
      (p.hasMore && !p.commits.length)
    )
      throw new Error('cursor_mismatch');
    return p as unknown as ChangesPage;
  }
  async inspectInbox(commitId:string):Promise<DecodedOperation[]> {
    const [row]=await this.db.read('SELECT * FROM sync_inbox WHERE commit_id=?',[commitId]);if(!row)throw new Error('inbox_missing');
    const envelope=decodeCommit(encodeUtf8(String(row.envelope_json)));sameScope(envelope,this.device.profile.pin);
    const accepted=String(row.accepted_registry_version),history=this.device.profile.grants.filter(g=>compareDecimal(g.registryVersion,accepted)<=0),registry=validateGrantChain(history,this.device.profile.pin,this.device.crypto);
    if(registry.checkpoint.version!==accepted)throw new Error('registry_order');const author=activeDevice(registry.devices,envelope.deviceId),{signature,...unsigned}=envelope;
    if(!this.device.crypto.verify(signature,commitSigningInput(unsigned),author.signingPublicKey))throw new Error('invalid_signature');
    const key=await this.device.secrets.load(this.device.scope('dataKey',envelope.keyVersion));if(!key)throw new Error('secret_unavailable');
    try{return envelope.operations.map((op,index)=>{const bytes=this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,this.device.crypto.decode(op.ciphertext),operationAssociatedData(unsigned,index),this.device.crypto.decode(op.nonce),key);if(!bytes)throw new Error('invalid_ciphertext');try{const revision=decodeCanonical(bytes,transportLimits.commitBytes);assertFinancialRevision(revision);return{...op,revision};}finally{this.device.crypto.erase(bytes);}});}finally{this.device.crypto.erase(key);}
  }
  async applyInbox(): Promise<void> {
    const state = await this.state();
    void state;
    const rows = await this.db.read(
      "SELECT * FROM sync_inbox WHERE state!='applied' ORDER BY length(log_position),log_position",
    );
    for (const row of rows) {
      let key: Uint8Array | null = null;
      try {
        const envelope = decodeCommit(encodeUtf8(String(row.envelope_json)));
        sameScope(envelope, this.device.profile.pin);
        if (envelope.keyVersion > (this.device.profile.activeKeyVersion ?? this.device.profile.pin.keyVersion))
          throw new Error('key_version_mismatch');
        const accepted = String(row.accepted_registry_version);
        assertDecimal64(accepted, true);
        if (compareDecimal(envelope.deviceRegistryVersion, accepted) > 0)
          throw new Error('registry_order');
        const history = this.device.profile.grants.filter(
          (g) => compareDecimal(g.registryVersion, accepted) <= 0,
        );
        const registry = validateGrantChain(
          history,
          this.device.profile.pin,
          this.device.crypto,
        );
        if (registry.checkpoint.version !== accepted)
          throw new Error('registry_order');
        const author = activeDevice(registry.devices, envelope.deviceId);
        const { signature, ...unsigned } = envelope;
        if (
          !this.device.crypto.verify(
            signature,
            commitSigningInput(unsigned),
            author.signingPublicKey,
          )
        )
          throw new Error('invalid_signature');
        const authored = validateGrantChain(
          history.filter(
            (g) =>
              compareDecimal(
                g.registryVersion,
                envelope.deviceRegistryVersion,
              ) <= 0,
          ),
          this.device.profile.pin,
          this.device.crypto,
        );
        activeDevice(authored.devices, envelope.deviceId);
        key = await this.device.secrets.load(this.device.scope('dataKey',envelope.keyVersion));
        if (!key) throw new Error('secret_unavailable');
        const operations: DecodedOperation[] = envelope.operations.map(
          (op, i) => {
            const bytes =
              this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                null,
                this.device.crypto.decode(op.ciphertext),
                operationAssociatedData(unsigned, i),
                this.device.crypto.decode(op.nonce),
                key!,
              );
            if (!bytes) throw new Error('invalid_ciphertext');
            try {
              const revision = decodeCanonical(
                bytes,
                transportLimits.commitBytes,
              );
              assertSupportedRevision(revision, state.mode === 'financial');
              return { ...op, revision };
            } finally {
              this.device.crypto.erase(bytes);
            }
          },
        );
        await this.db.run(
          applyCommit(
            envelope,
            String(row.log_position),
            accepted,
            operations,
            this.dialect,
            () => this.device.crypto.uuid(),
          ),
        );
      } catch (error) {
        await this.db.run(
          quarantine(
            String(row.commit_id),
            error instanceof Error ? error.message : 'invalid_envelope',
          ),
        );
      } finally {
        if (key) this.device.crypto.erase(key);
      }
    }
    await this.db.run(appliedCursor());
  }
  async pull():Promise<void>{
    let more = true;
    while (more) {
      const state = await this.state();
      const { serverId, serverEpoch, vaultId } = this.device.profile.pin;
      const value = await this.request(
        'changes',
        {
        formatVersion: 1,
        bindingId: state.binding_id,
        serverId,
        serverEpoch,
        vaultId,
        cursor: state.received_cursor,
        upperBound: state.pull_upper_bound,
        limit: 50,
        },
      );
      const page = this.page(value, state);
      await this.db.run(
        receivePage(
        String(state.binding_id),
        String(state.received_cursor),
        page.upperBound,
        page.nextCursor,
        page.commits,
        page.hasMore,
        ),
      );
      more = page.hasMore;
    }
    await this.applyInbox();
  }
  /** One ordered pass; the foreground coordinator owns scheduling. */
  async sync(): Promise<void> {
    if (this.running) throw new Error('sync_in_progress');
    this.running = true;
    try {
      const localState = await this.state();
      if (localState.mode === 'financial') {
        const [control] = await this.db.read('SELECT * FROM sync_control WHERE id=1');
        if (control.paused) throw new Error('sync_paused');
        await this.db.run(captureFinancial(() => this.device.crypto.uuid()));
      }
      const response = (await this.request(
        'registry',
        {},
      )) as RegistryResponse;
      this.device.acceptRegistry(response);
      if (localState.mode==='financial') await acceptKeyCheckpoints(this.device,response);
      await this.db.run(updateRegistry(this.device.profile));
      if (localState.mode==='financial') { await this.pull();await this.db.run(reissueForKeyVersion(this.device.profile.activeKeyVersion??this.device.profile.pin.keyVersion,()=>this.device.crypto.uuid())); }
      const rows = await this.db.read(
        "SELECT commit_id FROM sync_outbox WHERE state!='acknowledged' AND state!='blocked' ORDER BY length(local_seq),local_seq",
      );
      let sendError: unknown;
      for (const row of rows) {
        const id = String(row.commit_id);
        try {
          const bytes = await this.prepare(id),
            envelope = decodeCommit(encodeUtf8(bytes));
          await this.db.run(mark(id, 'in_flight', null));
          const value = await this.request('commits', envelope);
          await this.db.run(acknowledge(this.receipt(value, envelope)));
        } catch (error) {
          const code =
            error instanceof Error ? error.message : 'temporary_failure';
          await this.db.run(
            sendFailure(
              id,
              [
                'heads_changed',
                'idempotency_mismatch',
                'device_revoked',
                'invalid_signature',
                'key_version_mismatch',
              ].includes(code)
                ? 'blocked'
                : 'retry',
              code,
              this.dialect,
              () => this.device.crypto.uuid(),
            ),
          );
          sendError = error;
          break;
        }
      }
      await this.pull();
      if (sendError) throw sendError;
    } finally {
      this.running = false;
    }
  }
}
