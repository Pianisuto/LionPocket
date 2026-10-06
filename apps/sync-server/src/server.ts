import { onboardPairing, managePairing, namedRequest } from './pairing';
import { vaultControl, vaultRecoveryRequest } from './vaultControl';
import { epochActivation, type ActivationFault } from './epochActivation';
import { epochStaging } from './epochStaging';
import { epochRecovery } from './epochRecovery';
import { acceptCommit, changesPage, CommitRejection } from './commits';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  activeDevice,
  assertDeviceGrant,
  assertHttpProof,
  assertKeyDelivery,
  assertTrustPin,
  assertKeyVersion,
  stagingLimits,
  canonicalStringify,
  decodeCanonical,
  exactObject,
  sameScope,
  validateDelivery,
  validateGrantChain,
  verifyHttpProof,
  verifyPairing,
  type DeviceGrant,
  type HttpProof,
  type PairingRequest,
  type TrustPin,
} from '@lionpocket/sync-protocol';
import { ProvisioningCrypto } from '@lionpocket/sync-local';
import type { Identity } from './identity';

export async function initialize(pool: Pool) {
  await pool.query(
    'INSERT INTO sync_environment(singleton,server_id,server_epoch) VALUES(true,$1,$2) ON CONFLICT DO NOTHING',
    [randomUUID(), randomUUID()],
  );
  const env = (
    await pool.query('SELECT server_id,server_epoch FROM sync_environment')
  ).rows[0];
  return {
    serverId: env.server_id as string,
    serverEpoch: env.server_epoch as string,
  };
}
async function readBody(req: IncomingMessage, limit = 65536) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return {
    text: bytes.toString('utf8'),
    value: bytes.length ? decodeCanonical(bytes, limit) : null,
  };
}
async function chain(tx: PoolClient, vaultId: string): Promise<DeviceGrant[]> {
  return (
    await tx.query(
      'SELECT grant_envelope FROM sync_grants WHERE vault_id=$1 ORDER BY registry_version',
      [vaultId],
    )
  ).rows.map((row) => row.grant_envelope);
}
const knownErrors: Record<string, number> = {
  invite_invalid: 403, invite_expired: 410, invite_revoked: 410, invite_consumed: 409, pairing_denied: 403,
  recovery_confirmation_required: 409,
  invalid_key_base: 400,
  invalid_staging: 400,
  invalid_staging_batch: 400,
  staging_missing: 409,
  staging_closed: 409,
  staging_order: 409,
  staging_envelope_mismatch: 409,
  staging_count_mismatch: 409,
  staging_heads_mismatch: 409,
  staging_manifest_mismatch: 409,
  staging_not_validated: 409,
  invalid_recovery_envelope: 400,
  recovery_version_mismatch: 409,
  key_checkpoint_rollback: 409,
  invalid_key_checkpoint: 400,
  invalid_key_recipients: 400,
  invalid_epoch_activation: 400,
  activation_mismatch: 409,
  generation_archive_mismatch: 409,
  staging_not_prepared: 409,
  invalid_epoch_manifest: 400,
  invalid_epoch_transition: 400,
  epoch_transition_mismatch: 409,
  restore_record_required: 409,
  epoch_recovery_chain_required: 409,
  invalid_epoch_recovery: 400,
  invalid_epoch_challenge: 403,
  invalid_restored_state: 409,
  epoch_challenge_expired: 409,
  epoch_recovery_already_authorized: 409,
  idempotency_mismatch: 409,
  heads_changed: 409,
  missing_parents: 409,
  cursor_mismatch: 409,
  unsupported_version: 400,
  unauthenticated: 401,
  forbidden: 403,
  device_revoked: 403,
  invalid_signature: 403,
  replay: 409,
  binding_mismatch: 409,
  registry_order: 409,
  registry_rollback: 409,
  registry_fork: 409,
  pairing_exists: 409,
  pairing_missing: 409,
  vault_exists: 409,
  delivery_exists: 409,
  device_limit: 409,
  rate_limited: 429,
  epoch_changed: 409,
  payload_too_large: 413,
  invalid_envelope: 400,
  invalid_http_proof: 403,
  scope_mismatch: 403,
  key_version_mismatch: 409,
  fingerprint_mismatch: 403,
  invalid_pairing_grant: 403,
  invalid_registry: 400,
  invalid_founder: 403,
  invalid_device_transition: 409,
  duplicate_device_key: 409,
  founder_revocation_unavailable: 409,
};
export function controlServer(options: {
  financialEnabled?: boolean;
  /** Deprecated channel hint, ignored by the generic server. */
  privateBeta?: boolean;
  /** Restricted historical synthetic pilot only; production always uses full. */
  financialScope?: 'manual' | 'full';
  oidc?: { issuer: string; desktopClientId: string; androidClientId: string; desktopRedirect: string; androidRedirect: string };
  pool: Pool;
  crypto: ProvisioningCrypto;
  environment: { serverId: string; serverEpoch: string };
  origin: string;
  identity: (token: string) => Promise<Identity>;
  activationFault?: ActivationFault;
}) {
  const { pool, crypto, environment, origin, identity } = options;
  const attempts = new Map<string, { n: number; reset: number }>();
  const server = createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      let text = canonicalStringify(body);
      if (Buffer.byteLength(text, 'utf8') > 4194304) {
        status = 413;
        text = canonicalStringify({ error: 'payload_too_large' });
      }
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(text);
    };
    let tx: PoolClient | undefined;
    let proofConsumed = false;
    try {
      const rawTarget = req.url ?? '';
      const onboarding = /^\/v2\/pair\/([0-9a-f-]{36})\/(request|status)$/.exec(rawTarget);
      const deviceRoute = /^\/v2\/devices\/vaults\/([0-9a-f-]{36})\/(invite-create|invite-revoke|pairing-deny|pairing-list|grants|deliveries|key-checkpoints|recovery-store|registry|commits|changes)$/.exec(rawTarget);
      const target = deviceRoute ? `/v1/vaults/${deviceRoute[1]}/${deviceRoute[2]}` : rawTarget,
        method = req.method ?? '';
      if (method === 'GET' && ['/v1/environment', '/.well-known/lionpocket'].includes(target)) {
        respond(200, {
          ...environment,
          financialSyncEnabled: options.financialEnabled === true,
          entityScopes: options.financialEnabled ? (options.financialScope !== 'manual' ? ['category','paymentMethod','card','recurring','installmentPurchase','transaction','goal','recurringPriorityList','monthlyPriorityList'] : ['manualTransaction']) : [],
          ...(options.oidc ? {oidc:options.oidc} : {}),
          audience: 'lionpocket-sync-api',
          cryptoSuites: ['lp-sodium-v1'],
          ...(options.financialEnabled && options.financialScope !== 'manual' ? {pairingVersion: 2} : {}),
          controlVersion: 2,
          protocolVersion: 1,
          domainSchema: 1,
          epochRecovery: { formatVersion: 1, authorizationAvailable: true, stagingAvailable: true, activationAvailable: true },
        });
        return;
      }
      if ((onboarding || deviceRoute) && (!options.financialEnabled || options.financialScope === 'manual')) { respond(404,{error:'not_found'}); return; }
      if ((onboarding || deviceRoute) && method !== 'POST') { respond(404,{error:'not_found'}); return; }
      // Opt-in controls the only financial routes; every other domain remains absent.
      const create = method === 'POST' && target === '/v1/vaults';
      const match =
        /^\/v1\/vaults\/([0-9a-f-]{36})\/(invite-create|invite-revoke|pairing-deny|pairings|pairing-list|grants|deliveries|registry|commits|changes|recovery-fetch|recover|recovery-store|key-checkpoints|epoch-recovery-challenge|epoch-recovery-authorize|epoch-staging-begin|epoch-staging-batch|epoch-staging-validate|epoch-staging-prepare|epoch-staging-status|epoch-activation|epoch-activation-status)$/.exec(
          target,
        );
      if (
        !create && !onboarding &&
        (!match ||
          (method !== 'POST' &&
            !(method === 'GET' && ['registry', 'pairings'].includes(match[2]))))
      ) {
        respond(404, { error: 'not_found' });
        return;
      }
      if (
        match &&
        ['commits', 'changes'].includes(match[2]) &&
        !options.financialEnabled
      ) {
        respond(404, { error: 'not_found' });
        return;
      }
      // Discovery makes v0.3.11 stop before preparing any envelope. Enforce the
      // same floor here for already-running clients, cached sessions and requests
      // in flight across a server upgrade. No proof is consumed or state mutated.
      // This compatibility declaration supplements, never replaces, authorization.
      if (req.headers['x-lionpocket-control-version'] !== '2') {
        respond(426, { error: 'client_upgrade_required', controlVersion: 2 });
        return;
      }
      let token = '', account: Identity;
      if (onboarding) {
        // Bound memory and work before expensive signature/DB verification. Do not trust proxy headers.
        const now = Date.now(), key = req.socket.remoteAddress ?? 'unknown';
        for (const [ip,bucket] of attempts) if (bucket.reset <= now) attempts.delete(ip);
        if (attempts.size >= 10000 && !attempts.has(key)) throw new Error('rate_limited');
        const bucket = attempts.get(key) ?? { n: 0, reset: now + 60000 };
        attempts.set(key,bucket);
        if (++bucket.n > 90) throw new Error('rate_limited');
        account = { issuer: '', subject: '' };
      } else if (deviceRoute) {
        // Separate device transport: no capability or bearer token authorizes this route.
        // Existing /v1 account routes retain OIDC. The signed active grant and proof are checked below.
        const owner = (await pool.query('SELECT owner_issuer,owner_subject FROM sync_vaults WHERE vault_id=$1',[deviceRoute[1]])).rows[0];
        if (!owner) throw new Error('forbidden');
        account = { issuer: owner.owner_issuer, subject: owner.owner_subject };
      } else {
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ') || authorization.length > 16384) throw new Error('unauthenticated');
        token = authorization.slice(7);
        try { account = await identity(token); } catch { throw new Error('unauthenticated'); }
      }
      if (!onboarding && (await pool.query('SELECT 1 FROM sync_disabled_accounts WHERE issuer=$1 AND subject=$2', [account.issuer, account.subject])).rowCount) throw new Error('forbidden');
      const body = await readBody(
        req,
        match?.[2].startsWith('epoch-staging-') ? stagingLimits.requestBytes : match?.[2] === 'commits' ? 1048576 : 65536,
      );
      if (method === 'GET' && body.text) throw new Error('invalid_envelope');
      if (
        method === 'POST' &&
        req.headers['content-type'] !== 'application/json'
      )
        throw new Error('invalid_envelope');
      if (match && ['epoch-recovery-challenge', 'epoch-recovery-authorize'].includes(match[2])) {
        tx = await pool.connect();
        await tx.query('BEGIN');
        const result = await epochRecovery(tx, match[2], body.value, match[1], account, environment, crypto);
        await tx.query('COMMIT');
        respond(200, result);
        return;
      }
      if (match && ['epoch-activation', 'epoch-activation-status'].includes(match[2])) {
        tx = await pool.connect();
        await tx.query('BEGIN');
        const activate = match[2] === 'epoch-activation';
        const result = await epochActivation(tx, activate, body.value, match[1], account, environment, crypto, options.activationFault);
        if (activate) await options.activationFault?.('before_commit');
        await tx.query('COMMIT');
        if (activate) await options.activationFault?.('after_commit');
        respond(200, result);
        return;
      }
      if (match?.[2].startsWith('epoch-staging-')) {
        tx = await pool.connect();
        await tx.query('BEGIN');
        const result = await epochStaging(tx, match[2].slice('epoch-staging-'.length), body.value, match[1], account, environment, crypto);
        await tx.query('COMMIT');
        respond(200, result);
        return;
      }
      const rawProof = req.headers['x-lionpocket-proof'];
      if (typeof rawProof !== 'string' || rawProof.length > 8192)
        throw new Error('invalid_http_proof');
      const proof = decodeCanonical(Buffer.from(rawProof, 'base64url'));
      assertHttpProof(proof);
      if (
        Buffer.from(canonicalStringify(proof)).toString('base64url') !==
        rawProof
      )
        throw new Error('invalid_http_proof');
      if (
        proof.serverId !== environment.serverId ||
        proof.serverEpoch !== environment.serverEpoch
      )
        throw new Error('epoch_changed');
      tx = await pool.connect();
      await tx.query('BEGIN');
      const transaction = tx;
      const checkProof = async (proof: HttpProof, publicKey: string) => {
        verifyHttpProof(
          proof,
          {
            scope: proof,
            method,
            target: rawTarget,
            origin,
            body: body.text,
            token,
            now: Date.now(),
            publicKey,
          },
          crypto,
        );
        // Keep nonce consumption durable even when the control mutation is rejected.
        // A savepoint rolls back only the mutation, on the same connection/registry lock.
        const inserted = await transaction.query(
          'INSERT INTO sync_http_nonces(server_epoch,device_id,nonce,issued_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING nonce',
          [proof.serverEpoch, proof.deviceId, proof.nonce, proof.issuedAt],
        );
        if (!inserted.rowCount) throw new Error('replay');
        await transaction.query('SAVEPOINT control_mutation');
        proofConsumed = true;
      };
      if (onboarding) {
        const result = await onboardPairing(tx, onboarding[2] as 'request' | 'status', onboarding[1], body.value, proof, crypto, key => checkProof(proof,key));
        await tx.query('COMMIT'); respond(200,result); return;
      }
      let pin: TrustPin,
        grants: DeviceGrant[],
        request: PairingRequest | undefined;
      if (create) {
        const value = exactObject(body.value, ['pin', 'grant', 'request']);
        assertTrustPin(value.pin);
        assertDeviceGrant(value.grant);
        pin = value.pin;
        grants = [value.grant];
        request = value.request as PairingRequest;
        sameScope(pin, proof);
        verifyPairing(request, crypto);
        sameScope(request, pin);
        if (
          pin.serverId !== environment.serverId ||
          pin.serverEpoch !== environment.serverEpoch
        )
          throw new Error('epoch_changed');
        const registry = validateGrantChain(grants, pin, crypto);
        const founder = activeDevice(registry.devices, pin.founderDeviceId);
        if (
          proof.deviceId !== founder.deviceId ||
          request.deviceId !== founder.deviceId ||
          request.signingPublicKey !== founder.signingPublicKey ||
          request.boxPublicKey !== founder.boxPublicKey
        )
          throw new Error('invalid_pairing_grant');
        await checkProof(proof, founder.signingPublicKey);
        const inserted = await tx.query(
          'INSERT INTO sync_vaults(vault_id,owner_issuer,owner_subject,pin,base_key_version,active_key_version) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING vault_id',
          [pin.vaultId, account.issuer, account.subject, pin, pin.keyVersion],
        );
        if (!inserted.rowCount) throw new Error('vault_exists');
        await tx.query(
          'INSERT INTO sync_grants(vault_id,registry_version,grant_envelope) VALUES($1,1,$2)',
          [pin.vaultId, grants[0]],
        );
      } else {
        if (!match) throw new Error('invalid_envelope');
        const vaultId = match[1],
          action = match[2];
        if (proof.vaultId !== vaultId) throw new Error('scope_mismatch');
        const vault = (
          await tx.query(
            'SELECT * FROM sync_vaults WHERE vault_id=$1 FOR UPDATE',
            [vaultId],
          )
        ).rows[0];
        if (
          !vault ||
          vault.owner_issuer !== account.issuer ||
          vault.owner_subject !== account.subject
        )
          throw new Error('forbidden');
        pin = vault.pin;
        sameScope(pin, proof);
        grants = await chain(tx, vaultId);
        const registry = validateGrantChain(grants, pin, crypto);
        if (['recovery-fetch','recover'].includes(action) ) {
          const result=await vaultRecoveryRequest(tx,action,body.value,pin,grants,proof.deviceId,crypto,key=>checkProof(proof,key));
          await tx.query('COMMIT'); respond(200,result);return;
        }
        if (action === 'pairings' && method === 'POST') {
          request = body.value as PairingRequest;
          verifyPairing(request, crypto);
          sameScope(request, pin);
          if (request.deviceId !== proof.deviceId) throw new Error('forbidden');
          const existing = registry.devices.get(request.deviceId);
          if (existing?.status === 'revoked') throw new Error('device_revoked');
          if (existing) throw new Error('pairing_exists');
          await checkProof(proof, request.signingPublicKey);
          const previousRequest = (
            await tx.query(
              'SELECT request FROM sync_pairings WHERE vault_id=$1 AND device_id=$2',
              [vaultId, request.deviceId],
            )
          ).rows[0]?.request;
          if (
            previousRequest &&
            canonicalStringify(previousRequest) !== canonicalStringify(request)
          )
            throw new Error('pairing_exists');
          const pending = (
            await tx.query(
              'SELECT count(*)::int AS n FROM sync_pairings WHERE vault_id=$1 AND NOT approved AND NOT denied',
              [vaultId],
            )
          ).rows[0].n;
          if (!previousRequest && pending >= 10)
            throw new Error('rate_limited');
          const inserted = await tx.query(
            'INSERT INTO sync_pairings(vault_id,device_id,fingerprint,request) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING device_id',
            [vaultId, request.deviceId, request.fingerprint, request],
          );
          if (!inserted.rowCount && !previousRequest)
            throw new Error('pairing_exists');
        } else {
          const author = activeDevice(registry.devices, proof.deviceId);
          await checkProof(proof, author.signingPublicKey);
          if (['invite-create','invite-revoke','pairing-deny'].includes(action)) {
            const result = await managePairing(tx,action,body.value,vaultId,crypto);
            await tx.query('COMMIT'); respond(200,result); return;
          }
          if (['key-checkpoints','recovery-store'].includes(action)) {
            await vaultControl(tx,action,body.value,pin,grants,crypto);
          }
          if (action === 'commits' || action === 'changes') {
            if (action==='commits' && options.financialScope !== 'manual' && vault.rotation_required) throw new Error('rotation_required');
            const result =
              action === 'commits'
                ? await acceptCommit(
                    tx,
                    Buffer.from(body.text, 'utf8'),
                    pin,
                    grants,
                    proof.deviceId,
                    crypto,
                    Number(vault.active_key_version),
                  )
                : await changesPage(tx, body.value, pin, proof.deviceId);
            await tx.query('COMMIT');
            respond(200, result);
            return;
          }
          if (action === 'pairings' || action === 'pairing-list') {
            if (options.financialScope === 'manual' && proof.deviceId !== pin.founderDeviceId)
              throw new Error('forbidden');
            const requests = (
              await tx.query(
                'SELECT p.request,p.device_name,p.invite_id,p.pairing_auth FROM sync_pairings p LEFT JOIN sync_pairing_invites i ON i.invite_id=p.invite_id WHERE p.vault_id=$1 AND NOT p.approved AND NOT p.denied AND (p.invite_id IS NULL OR (NOT i.revoked AND i.expires_at>$2)) ORDER BY p.device_id',
                [vaultId,Date.now()],
              )
            ).rows.map((r) => namedRequest(r,crypto));
            await tx.query('COMMIT');
            respond(200, { requests });
            return;
          }
          if (action === 'grants') {
            if (options.financialScope === 'manual' && proof.deviceId !== pin.founderDeviceId)
              throw new Error('forbidden');
            const grant = body.value;
            assertDeviceGrant(grant);
            validateGrantChain([...grants, grant], pin, crypto);
            if (grant.status === 'approved') {
              const pendingPairing = (
                await tx.query(
                  'SELECT p.request,i.revoked,i.expires_at FROM sync_pairings p LEFT JOIN sync_pairing_invites i ON i.invite_id=p.invite_id WHERE p.vault_id=$1 AND p.device_id=$2 AND NOT p.approved AND NOT p.denied',
                  [vaultId, grant.deviceId],
                )
              ).rows[0];
              if (pendingPairing?.revoked) throw new Error('invite_revoked');
              if (pendingPairing?.expires_at && Number(pendingPairing.expires_at) <= Date.now()) throw new Error('invite_expired');
              const pairing = pendingPairing?.request as PairingRequest | undefined;
              if (!pairing) throw new Error('pairing_missing');
              verifyPairing(pairing, crypto);
              if (
                pairing.signingPublicKey !== grant.signingPublicKey ||
                pairing.boxPublicKey !== grant.boxPublicKey
              )
                throw new Error('invalid_pairing_grant');
              await tx.query(
                'UPDATE sync_pairings SET approved=true WHERE vault_id=$1 AND device_id=$2',
                [vaultId, grant.deviceId],
              );
            }
            await tx.query(
              'INSERT INTO sync_grants(vault_id,registry_version,grant_envelope) VALUES($1,$2,$3)',
              [vaultId, grant.registryVersion, grant],
            );
            await tx.query(
              'UPDATE sync_vaults SET registry_version=$2 WHERE vault_id=$1',
              [vaultId, grant.registryVersion],
            );
            grants.push(grant);
            if (options.financialScope !== 'manual' && grant.status==='revoked') await tx.query('UPDATE sync_vaults SET rotation_required=true WHERE vault_id=$1',[vaultId]);
          }
          if (action === 'deliveries') {
            const delivery = body.value;
            assertKeyDelivery(delivery);
            if (delivery.authorDeviceId !== proof.deviceId)
              throw new Error('forbidden');
            const activeKeyVersion = Number(vault.active_key_version);
            assertKeyVersion(activeKeyVersion);
            // An immutable, signed delivery can be in flight across a subsequent rotation.
            // Accept an authenticated historical generation key; normal commits still require the active key.
            if (delivery.keyVersion > activeKeyVersion) throw new Error('key_version_mismatch');
            validateDelivery(delivery, grants, pin, crypto);
            if (delivery.registryVersion !== registry.checkpoint.version)
              throw new Error('registry_order');
            const inserted = await tx.query(
              'INSERT INTO sync_deliveries(vault_id,recipient_device_id,delivery) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING recipient_device_id',
              [vaultId, delivery.recipientDeviceId, delivery],
            );
            if (!inserted.rowCount) throw new Error('delivery_exists');
          }
        }
      }
      const delivery =
        (
          await tx.query(
            'SELECT delivery FROM sync_deliveries WHERE vault_id=$1 AND recipient_device_id=$2',
            [pin.vaultId, proof.deviceId],
          )
        ).rows[0]?.delivery ?? null;
      const security=options.financialScope !== 'manual' ? (await tx.query('SELECT key_checkpoints,recovery,rotation_required FROM sync_vaults WHERE vault_id=$1',[pin.vaultId])).rows[0] : null;
      await tx.query('COMMIT');
      respond(create ? 201 : 200, { pin, grants, delivery,...(security?{keyCheckpoints:security.key_checkpoints,recovery:security.recovery,rotationRequired:security.rotation_required}:{}) });
    } catch (error) {
      if (tx) {
        try {
          if (proofConsumed) {
            await tx.query('ROLLBACK TO SAVEPOINT control_mutation');
            await tx.query('COMMIT');
          } else await tx.query('ROLLBACK');
        } catch {
          await tx.query('ROLLBACK').catch(() => undefined);
        }
      }
      const message =
        error instanceof Error ? error.message : 'temporary_failure';
      // Validation errors never include bodies, token, key material or stack traces in logs/responses.
      const status =
        knownErrors[message] ??
        (message.startsWith('Expected ') ||
        message.startsWith('Invalid ') ||
        message.startsWith('Noncanonical') ||
        message.includes('UTF-8')
          ? 400
          : 503);
      respond(status, {
        ...(error instanceof CommitRejection
          ? { missingParents: error.missingParents }
          : {}),
        error: knownErrors[message]
          ? message
          : status === 400
            ? 'invalid_envelope'
            : 'temporary_failure',
      });
    } finally {
      tx?.release();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
