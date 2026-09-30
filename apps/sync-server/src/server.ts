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
  pool: Pool;
  crypto: ProvisioningCrypto;
  environment: { serverId: string; serverEpoch: string };
  origin: string;
  identity: (token: string) => Promise<Identity>;
}) {
  const { pool, crypto, environment, origin, identity } = options;
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
      const target = req.url ?? '',
        method = req.method ?? '';
      if (method === 'GET' && target === '/v1/environment') {
        respond(200, {
          ...environment,
          financialSyncEnabled: options.financialEnabled === true,
          entityScopes: options.financialEnabled ? ['manualTransaction'] : [],
          controlVersion: 1,
        });
        return;
      }
      // Opt-in controls the only financial routes; every other domain remains absent.
      const create = method === 'POST' && target === '/v1/vaults';
      const match =
        /^\/v1\/vaults\/([0-9a-f-]{36})\/(pairings|grants|deliveries|registry|commits|changes)$/.exec(
          target,
        );
      if (
        !create &&
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
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith('Bearer ') || authorization.length > 16384)
        throw new Error('unauthenticated');
      const token = authorization.slice(7);
      let account: Identity;
      try {
        account = await identity(token);
      } catch {
        throw new Error('unauthenticated');
      }
      const body = await readBody(
        req,
        match?.[2] === 'commits' ? 1048576 : 65536,
      );
      if (method === 'GET' && body.text) throw new Error('invalid_envelope');
      if (
        method === 'POST' &&
        req.headers['content-type'] !== 'application/json'
      )
        throw new Error('invalid_envelope');
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
            target,
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
          'INSERT INTO sync_vaults(vault_id,owner_issuer,owner_subject,pin) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING vault_id',
          [pin.vaultId, account.issuer, account.subject, pin],
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
              'SELECT count(*)::int AS n FROM sync_pairings WHERE vault_id=$1 AND NOT approved',
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
          if (action === 'commits' || action === 'changes') {
            const result =
              action === 'commits'
                ? await acceptCommit(
                    tx,
                    Buffer.from(body.text, 'utf8'),
                    pin,
                    grants,
                    proof.deviceId,
                    crypto,
                  )
                : await changesPage(tx, body.value, pin, proof.deviceId);
            await tx.query('COMMIT');
            respond(200, result);
            return;
          }
          if (action === 'pairings') {
            if (proof.deviceId !== pin.founderDeviceId)
              throw new Error('forbidden');
            const requests = (
              await tx.query(
                'SELECT request FROM sync_pairings WHERE vault_id=$1 AND NOT approved ORDER BY device_id',
                [vaultId],
              )
            ).rows.map((r) => r.request);
            await tx.query('COMMIT');
            respond(200, { requests });
            return;
          }
          if (action === 'grants') {
            if (proof.deviceId !== pin.founderDeviceId)
              throw new Error('forbidden');
            const grant = body.value;
            assertDeviceGrant(grant);
            validateGrantChain([...grants, grant], pin, crypto);
            if (grant.status === 'approved') {
              const pairing = (
                await tx.query(
                  'SELECT request FROM sync_pairings WHERE vault_id=$1 AND device_id=$2 AND NOT approved',
                  [vaultId, grant.deviceId],
                )
              ).rows[0]?.request as PairingRequest | undefined;
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
          }
          if (action === 'deliveries') {
            const delivery = body.value;
            assertKeyDelivery(delivery);
            if (delivery.authorDeviceId !== proof.deviceId)
              throw new Error('forbidden');
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
      await tx.query('COMMIT');
      respond(create ? 201 : 200, { pin, grants, delivery });
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
