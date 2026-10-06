import React from 'react';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from 'react-test-renderer';
import { SyncPanel as DesktopSyncPanel } from '../../desktop/src/ui/SyncPanel';
import { SyncPanel as MobileSyncPanel } from '../../mobile/src/ui/SyncPanel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import pg from 'pg';
import sodium from 'libsodium-wrappers-sumo';
import {
  canonicalStringify,
  encodeUtf8,
  pairingCapabilityInput,
  parsePairingInvitation,
  pairingLink,
  type HttpProof,
} from '@lionpocket/sync-protocol';
import {
  SyncController,
  DeviceProvisioning,
  ProvisioningCrypto,
  type SyncSaved,
  type SyncOptions,
  type LocalSyncDatabase,
} from '@lionpocket/sync-local';
import { LionPocketDatabase } from '../../desktop/src/main/database';
import { sqliteTestConnection } from '../../mobile/src/db/sqliteTestConnection';
import { migrate } from '../../mobile/src/db/migrations';
import { mobileSyncDatabase } from '../../mobile/src/sync/database';
import { MobileRepository } from '../../mobile/src/db/repository';
import { controlServer, initialize } from './server';
import { controlSchema, commitSchema, bindingSchema } from './schema';
import { TestSecrets, syntheticBrowserLogin } from './testSupport';
import { loginDevelopmentOidc } from '../../desktop/src/main/sync/oidc';
import { keycloakIdentity } from './identity';

const mobileRuntime = vi.hoisted(() => ({
  controller: undefined as SyncController | undefined,
}));
vi.mock('../../mobile/src/sync/sync', () => ({
  syncController: async () => mobileRuntime.controller,
  betaEndpoint: '',
}));
vi.mock('react-native', () => ({
  Text: 'mobile-text',
  TextInput: 'mobile-input',
  View: 'mobile-view',
  Share: { share: vi.fn() },
  NativeModules: {},
}));
vi.mock('../../mobile/src/ui/components', async () => {
  const React = await import('react');
  return {
    useStyles: () => ({}),
    Button: (props: Record<string, unknown>) =>
      React.createElement('mobile-button', props),
  };
});
function renderedText(node: ReactTestInstance | string): string {
  return typeof node === 'string'
    ? node
    : node.children.map((child) => renderedText(child)).join('');
}
const enabled = process.env.LIONPOCKET_SYNC_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'LPV2: four human actions, real PostgreSQL/Keycloak and Desktop/Android SQLite adapters',
  () => {
    const database = 'lion_pairing_' + randomUUID().replaceAll('-', '');
    const endpoint = 'http://127.0.0.1:18778',
      issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
    let admin: pg.Pool,
      pool: pg.Pool,
      server: Server,
      crypto: ProvisioningCrypto;
    let session: Awaited<ReturnType<typeof loginDevelopmentOidc>>;
    const controllers: SyncController[] = [],
      close: (() => void)[] = [];
    beforeAll(async () => {
      await sodium.ready;
      crypto = new ProvisioningCrypto(sodium);
      admin = new pg.Pool({
        connectionString:
          'postgresql://liondev:liondev@127.0.0.1:55432/postgres',
      });
      await admin.query(`CREATE DATABASE ${database}`);
      pool = new pg.Pool({
        connectionString: `postgresql://liondev:liondev@127.0.0.1:55432/${database}`,
      });
      await pool.query(controlSchema + commitSchema + bindingSchema);
      server = controlServer({
        pool,
        crypto,
        environment: await initialize(pool),
        origin: endpoint,
        identity: keycloakIdentity(issuer),
        financialEnabled: true,
        oidc: {
          issuer,
          desktopClientId: 'lionpocket-desktop-dev',
          androidClientId: 'lionpocket-android-dev',
          desktopRedirect: 'http://127.0.0.1:18761/callback',
          androidRedirect: 'com.lionpocketmobile.syncdev:/callback',
        },
      });
      await new Promise<void>((resolve) =>
        server.listen(18778, '127.0.0.1', resolve),
      );
      session = await loginDevelopmentOidc(
        'lionpocket-desktop-dev',
        syntheticBrowserLogin,
        20000,
      );
    }, 30000);
    afterAll(async () => {
      for (const c of controllers) {
        c.setForeground(false);
        await c.coordinator.cancelAndWait();
        c.coordinator.dispose();
      }
      close.forEach((f) => f());
      server?.closeAllConnections();
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.end();
      }
    });
    async function client(dialect: 'desktop' | 'android', owner = false) {
      let db: LocalSyncDatabase;
      let write: () => Promise<void>, rows: () => Promise<unknown[]>;
      if (dialect === 'desktop') {
        const bank = new LionPocketDatabase(':memory:');
        close.push(() => bank.db.close());
        bank.db.exec(
          'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
        );
        db = bank.syncDatabase();
        write = async () => {
          bank.saveTransaction({
            kind: 'expense',
            description: 'E2EE pairing canary 🦁',
            plannedAmount: 42,
            dueDate: '2026-10-06',
            status: 'planned',
          });
        };
        rows = async () => bank.listTransactions({ month: '2026-10' });
      } else {
        const bank = sqliteTestConnection();
        close.push(() => bank.sqlite.close());
        await migrate(bank.db);
        bank.sqlite.exec(
          'DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;',
        );
        db = mobileSyncDatabase(bank.db);
        const repo = new MobileRepository(bank.db, randomUUID);
        write = async () =>
          repo.save({
            kind: 'expense',
            description: 'E2EE pairing canary 🦁',
            plannedAmount: 42,
            dueDate: '2026-10-06',
            status: 'planned',
          });
        rows = () => repo.list({ month: '2026-10' });
      }
      let saved: SyncSaved | null = null;
      const secrets = new TestSecrets(),
        login = vi.fn(async () => {
          if (!owner) throw new Error('NEW_DEVICE_MUST_NOT_LOGIN');
          return session;
        });
      const options: SyncOptions = {
        db,
        secrets,
        sodium,
        dialect,
        allowLocalDevelopment: true,
        deviceName: dialect === 'android' ? 'Galaxy S23' : 'Computador',
        storage: {
          load: async () => (saved ? structuredClone(saved) : null),
          save: async (value) => {
            saved = structuredClone(value);
          },
        },
        backup: async () => '/private/synthetic-pairing-backup.sqlite',
        login,
      };
      let sync = new SyncController(options);
      controllers.push(sync);
      sync.setForeground(true);
      const restart = async () => {
        sync.setForeground(false);
        await sync.coordinator.cancelAndWait();
        sync.coordinator.dispose();
        // New database adapter models reopening the same persisted bank in a new process.
        options.db = {
          read: (sql, params) => db.read(sql, params),
          run: (workflow) => db.run(workflow),
        };
        sync = new SyncController(options);
        controllers.push(sync);
        sync.setForeground(true);
        return sync;
      };
      return {
        get sync() {
          return sync;
        },
        options,
        secrets,
        login,
        write,
        rows,
        profile: () => saved!,
        restart,
      };
    }
    async function send(
      d: DeviceProvisioning,
      target: string,
      value: unknown,
      proof?: HttpProof,
      token = '',
    ) {
      const body = canonicalStringify(value),
        signed =
          proof ?? (await d.proof('POST', target, endpoint, body, token));
      const response = await fetch(endpoint + target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lionpocket-control-version': '2',
          'x-lionpocket-proof': crypto.encode(
            encodeUtf8(canonicalStringify(signed)),
          ),
          authorization: 'Bearer ' + token,
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    }
    async function owner(dialect: 'desktop' | 'android' = 'desktop') {
      const a = await client(dialect, true);
      await a.write();
      await a.sync.configure(endpoint);
      await a.sync.create();
      await expect
        .poll(() => a.sync.coordinator.lastCompletedAt, { timeout: 15000 })
        .toBeTruthy();
      expect(a.login).toHaveBeenCalledTimes(1);
      expect((await a.sync.status()).phase).toBe('bound');
      expect((await a.sync.status()).recoveryVersion).toBe('0');
      return a;
    }
    for (const [from, to] of [
      ['desktop', 'android'],
      ['android', 'desktop'],
      ['android', 'android'],
    ] as const) {
      it(`${from} → ${to}: QR/link, Conectar, Aprovar; automatic discovery/delivery/first sync`, async () => {
        const a = await owner(from),
          b = await client(to);
        const actions: string[] = [];
        actions.push('Abrir Adicionar aparelho');
        const { link } = await a.sync.createInvitation();
        actions.push('Escanear QR / abrir deep link');
        const info = await b.sync.inspectPairingInvitation(link);
        expect(info.endpoint).toBe(endpoint);
        expect(b.profile()).toBeNull();
        actions.push('Conectar');
        await b.sync.connectInvitation(link);
        expect(b.profile().endpoint).toBe(endpoint);
        expect(b.profile().discovered?.pairingVersion).toBe(2);
        expect(b.profile().phase).toBe('pairing');
        expect(b.login).not.toHaveBeenCalled();
        await expect
          .poll(async () => (await a.sync.status()).pairingRequests.length, {
            timeout: 15000,
          })
          .toBe(1);
        const request = (await a.sync.status()).pairingRequests[0];
        expect(request.deviceName).toBe(
          to === 'android' ? 'Galaxy S23' : 'Computador',
        );
        expect(request.securityCode).toBe((await b.sync.status()).pairingCode);
        const device = new DeviceProvisioning(
          b.profile().profile!,
          b.secrets,
          crypto,
        );
        const pending = await send(
          device,
          `/v2/pair/${b.profile().pairingInvite!.id}/status`,
          {},
        );
        expect(pending.body).toEqual({ state: 'waiting' });
        expect(await b.secrets.load(device.scope('dataKey'))).toBeNull();
        expect(
          (
            await send(
              device,
              `/v2/devices/vaults/${device.profile.pin.vaultId}/registry`,
              {},
            )
          ).status,
        ).toBe(403);
        actions.push('Aprovar aparelho');
        await a.sync.approve(request.deviceId);
        await expect
          .poll(async () => (await b.sync.status()).phase, { timeout: 15000 })
          .toBe('bound');
        await expect
          .poll(() => b.sync.coordinator.lastCompletedAt, { timeout: 15000 })
          .toBeTruthy();
        expect(await b.rows()).toMatchObject([
          { description: 'E2EE pairing canary 🦁', plannedAmount: 42 },
        ]);
        expect(actions).toHaveLength(4);
        expect(b.login).not.toHaveBeenCalled();
        expect(a.login).toHaveBeenCalledTimes(1);
        const vaultId = a.profile().profile!.pin.vaultId;
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM sync_grants WHERE vault_id=$1',
              [vaultId],
            )
          ).rows[0].n,
        ).toBe(2);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM sync_deliveries WHERE vault_id=$1',
              [vaultId],
            )
          ).rows[0].n,
        ).toBe(1);
        const serialized = canonicalStringify(
          (
            await pool.query(
              'SELECT * FROM sync_pairing_invites WHERE vault_id=$1',
              [vaultId],
            )
          ).rows,
        );
        const invite = parsePairingInvitation(link, crypto);
        expect(serialized).not.toContain(invite.capability);
        expect(canonicalStringify(b.profile())).not.toContain(
          invite.capability,
        );
        a.sync.setForeground(false);
        b.sync.setForeground(false);
      }, 30000);
    }
    it('E2E UX drives the actual Desktop and Mobile panels: exactly four human actions and no technical intermediate button', async () => {
      const a = await owner(),
        b = await client('android');
      const actions: string[] = [],
        commands: string[] = [];
      let issuedLink = '',
        desktop: ReactTestRenderer | undefined,
        mobile: ReactTestRenderer | undefined;
      const command = async (action: string, args: unknown[]) => {
        commands.push(action);
        if (action === 'invite-create') {
          const result = await a.sync.createInvitation();
          issuedLink = result.link;
          return result;
        }
        if (action === 'approve') return a.sync.approve(String(args[0]));
        throw new Error('Unexpected mandatory command: ' + action);
      };
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('window', {
        lionPocket: {
          syncStatus: () => a.sync.status(),
          syncCommand: command,
          onSyncChanged: (f: () => void) => a.sync.subscribe(f),
        },
      });
      mobileRuntime.controller = b.sync;
      const button = (root: ReactTestRenderer, label: string) =>
        root.root
          .findAllByType('button')
          .find((node) => renderedText(node).trim() === label)!;
      const mobileButton = (label: string) =>
        mobile!.root.findAll(
          (node) =>
            node.type === ('mobile-button' as unknown) &&
            node.props.label === label,
        )[0];
      const flush = async <T>(read: () => T) => {
        await act(async () => {
          /* Flush async UI effects, without any user gesture. */
        });
        return read();
      };
      try {
        await act(async () => {
          desktop = create(
            React.createElement(DesktopSyncPanel, {
              onChanged: async () => undefined,
            }),
          );
        });
        await expect
          .poll(() => flush(() => !!button(desktop!, 'Adicionar aparelho')))
          .toBe(true);
        actions.push('Desktop: Adicionar aparelho');
        await act(async () =>
          button(desktop!, 'Adicionar aparelho').props.onClick(),
        );
        await expect.poll(() => flush(() => !!issuedLink)).toBe(true);
        actions.push('Android: escanear QR (deep link equivalente)');
        await act(async () => {
          mobile = create(
            React.createElement(MobileSyncPanel, {
              initialInvitation: issuedLink,
              onChanged: async () => undefined,
            }),
          );
        });
        await expect
          .poll(() => flush(() => !!mobileButton('Conectar')))
          .toBe(true);
        expect(
          mobile!.root.findAll(
            (node) =>
              node.type === ('mobile-input' as unknown) &&
              /segurança|fingerprint|conferido/i.test(
                node.props.accessibilityLabel ?? '',
              ),
          ),
        ).toHaveLength(0);
        actions.push('Android: Conectar');
        await act(async () => mobileButton('Conectar').props.onPress());
        await expect
          .poll(() => flush(() => !!button(desktop!, 'Aprovar aparelho')), {
            timeout: 15000,
          })
          .toBe(true);
        expect(
          desktop!.root
            .findAllByType('input')
            .filter((node) =>
              /segurança|fingerprint|conferido|Código do aparelho/i.test(
                node.props['aria-label'] ?? '',
              ),
            ),
        ).toHaveLength(0);
        actions.push('Desktop: Aprovar aparelho');
        await act(async () =>
          button(desktop!, 'Aprovar aparelho').props.onClick(),
        );
        await expect
          .poll(
            () =>
              flush(() =>
                renderedText(mobile!.root).includes('Sincronização pronta'),
              ),
            { timeout: 15000 },
          )
          .toBe(true);
        expect(await b.rows()).toMatchObject([
          { description: 'E2EE pairing canary 🦁' },
        ]);
        expect(actions).toHaveLength(4);
        expect(commands).toEqual(['invite-create', 'approve']);
        expect(
          renderedText(desktop!.root) + renderedText(mobile!.root),
        ).not.toMatch(
          /Conferir convite|Buscar pedidos|Receber chave|TrustPin|controlVersion|authority fingerprint/,
        );
        expect(b.login).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          desktop?.unmount();
          mobile?.unmount();
        });
        mobileRuntime.controller = undefined;
        vi.unstubAllGlobals();
        a.sync.setForeground(false);
        b.sync.setForeground(false);
      }
    }, 30000);

    it('rejects tampering, invalid capability, pin-only access, LPV1 pairing and replay; request recovery is idempotent with a fresh proof', async () => {
      const a = await owner(),
        b = await client('android'),
        { link } = await a.sync.createInvitation();
      const invitation = parsePairingInvitation(link, crypto),
        pin = invitation.invite.pin;
      const device = await DeviceProvisioning.prepare(pin, b.secrets, crypto),
        request = await device.request();
      const deviceName = 'Galaxy S23',
        target = `/v2/pair/${invitation.invite.id}/request`;
      const seed = crypto.decode(invitation.capability);
      const value = {
        request,
        deviceName,
        capabilitySignature: crypto.sign(
          pairingCapabilityInput(invitation.invite, request, deviceName),
          seed,
        ),
      };
      crypto.erase(seed);
      expect(
        (
          await send(device, target, {
            ...value,
            capabilitySignature: crypto.nonce(),
          })
        ).status,
      ).toBe(403);
      expect((await send(device, target, { request, deviceName })).status).toBe(
        400,
      );
      const malicious = structuredClone(invitation);
      malicious.invite.endpoint = 'https://attacker.invalid';
      await expect(
        b.sync.connectInvitation(pairingLink(malicious, crypto)),
      ).rejects.toThrow('invite_invalid');
      await expect(
        b.sync.inspectPairingInvitation((await a.sync.status()).invitation),
      ).rejects.toThrow('invite_legacy');
      malicious.invite.endpoint = invitation.invite.endpoint;
      malicious.capability = crypto.nonce();
      await expect(
        b.sync.connectInvitation(pairingLink(malicious, crypto)),
      ).rejects.toThrow('invite_invalid');
      const proof = await device.proof(
        'POST',
        target,
        endpoint,
        canonicalStringify(value),
        '',
      );
      expect((await send(device, target, value, proof)).status).toBe(200);
      expect((await send(device, target, value, proof)).body.error).toBe(
        'replay',
      );
      expect((await send(device, target, value)).status).toBe(200);
      const thief = await DeviceProvisioning.prepare(
          pin,
          new TestSecrets(),
          crypto,
        ),
        thiefRequest = await thief.request();
      const secret = crypto.decode(invitation.capability);
      const stolen = {
        request: thiefRequest,
        deviceName,
        capabilitySignature: crypto.sign(
          pairingCapabilityInput(invitation.invite, thiefRequest, deviceName),
          secret,
        ),
      };
      crypto.erase(secret);
      expect((await send(thief, target, stolen)).body.error).toBe(
        'invite_consumed',
      );
      expect(
        (await send(thief, `/v2/pair/${invitation.invite.id}/status`, {}))
          .status,
      ).toBe(403);
      expect(
        (await send(device, `/v2/devices/vaults/${pin.vaultId}/changes`, {}))
          .status,
      ).toBe(403);
      a.sync.setForeground(false);
      b.sync.setForeground(false);
    }, 30000);
    it('rejects server substitution or stripping of capability authentication; upgrading an existing owner needs no fresh OIDC', async () => {
      const a = await owner(),
        b = await client('android');
      a.sync.setForeground(false);
      const previous = a.profile();
      delete previous.deviceTransport;
      await a.options.storage.save(previous);
      await a.restart();
      const { link } = await a.sync.createInvitation();
      expect(a.login).toHaveBeenCalledTimes(1);
      await b.sync.connectInvitation(link);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      const deviceId = b.profile().profile!.deviceId,
        vaultId = a.profile().profile!.pin.vaultId;
      a.sync.setForeground(false);
      const original = (
        await pool.query(
          'SELECT pairing_auth FROM sync_pairings WHERE vault_id=$1 AND device_id=$2',
          [vaultId, deviceId],
        )
      ).rows[0].pairing_auth;
      await pool.query(
        'UPDATE sync_pairings SET pairing_auth=$3 WHERE vault_id=$1 AND device_id=$2',
        [
          vaultId,
          deviceId,
          { ...original, capabilitySignature: crypto.nonce() },
        ],
      );
      await expect(a.sync.approve(deviceId)).rejects.toThrow('invite_invalid');
      await pool.query(
        'UPDATE sync_pairings SET pairing_auth=NULL WHERE vault_id=$1 AND device_id=$2',
        [vaultId, deviceId],
      );
      await expect(a.sync.approve(deviceId)).rejects.toThrow(
        'client_upgrade_required',
      );
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM sync_deliveries WHERE vault_id=$1',
            [vaultId],
          )
        ).rows[0].n,
      ).toBe(0);
      const d = new DeviceProvisioning(b.profile().profile!, b.secrets, crypto);
      expect(await b.secrets.load(d.scope('dataKey'))).toBeNull();
      b.sync.setForeground(false);
    }, 30000);
    it('expires/revokes invitations, rejects denied devices and prevents account/authority operations with the invite', async () => {
      const a = await owner(),
        b = await client('android');
      let issued = await a.sync.createInvitation(),
        invite = parsePairingInvitation(issued.link, crypto);
      const device = await DeviceProvisioning.prepare(
          invite.invite.pin,
          new TestSecrets(),
          crypto,
        ),
        request = await device.request();
      const attempt = async () => {
        const seed = crypto.decode(invite.capability),
          name = 'Synthetic';
        const v = {
          request,
          deviceName: name,
          capabilitySignature: crypto.sign(
            pairingCapabilityInput(invite.invite, request, name),
            seed,
          ),
        };
        crypto.erase(seed);
        return send(device, `/v2/pair/${invite.invite.id}/request`, v);
      };
      await pool.query(
        'UPDATE sync_pairing_invites SET expires_at=1 WHERE invite_id=$1',
        [invite.invite.id],
      );
      expect((await attempt()).body.error).toBe('invite_expired');
      issued = await a.sync.createInvitation();
      invite = parsePairingInvitation(issued.link, crypto);
      await a.sync.cancelInvitation();
      expect((await attempt()).body.error).toBe('invite_revoked');
      issued = await a.sync.createInvitation();
      await b.sync.connectInvitation(issued.link);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      await a.sync.deny(b.profile().profile!.deviceId);
      await expect
        .poll(async () => (await b.sync.status()).pairingError, {
          timeout: 15000,
        })
        .toBe('Pedido recusado');
      const d = new DeviceProvisioning(b.profile().profile!, b.secrets, crypto);
      expect(await b.secrets.load(d.scope('dataKey'))).toBeNull();
      for (const action of [
        'grants',
        'deliveries',
        'invite-create',
        'key-checkpoints',
        'commits',
        'registry',
      ])
        expect(
          (
            await send(
              d,
              `/v2/devices/vaults/${d.profile.pin.vaultId}/${action}`,
              {},
            )
          ).status,
        ).toBe(403);
      expect((await send(d, '/v1/vaults', {})).status).toBe(401);
      expect(
        (await send(d, `/v1/vaults/${d.profile.pin.vaultId}/registry`, {}))
          .status,
      ).toBe(401);
      a.sync.setForeground(false);
      b.sync.setForeground(false);
    }, 30000);
    it('a refused Android can scan a fresh invite and confirm once with the same persisted identity', async () => {
      const a = await owner(),
        b = await client('android');
      await b.sync.connectInvitation((await a.sync.createInvitation()).link);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      const deviceId = b.profile().profile!.deviceId;
      await a.sync.deny(deviceId);
      await expect
        .poll(async () => (await b.sync.status()).pairingError, {
          timeout: 15000,
        })
        .toBe('Pedido recusado');
      const { link } = await a.sync.createInvitation();
      mobileRuntime.controller = b.sync;
      let screen!: ReactTestRenderer;
      await act(async () => {
        screen = create(
          React.createElement(MobileSyncPanel, {
            initialInvitation: link,
            onChanged: async () => undefined,
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const connect = screen.root
        .findAll((node) => typeof node.type === 'string' && node.props.label === 'Conectar');
      expect(connect).toHaveLength(1);
      await act(async () => {
        await connect[0].props.onPress();
      });
      expect(b.profile().profile!.deviceId).toBe(deviceId);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      await a.sync.approve(deviceId);
      await expect
        .poll(async () => (await b.sync.status()).phase, { timeout: 15000 })
        .toBe('bound');
      expect(b.login).not.toHaveBeenCalled();
      await act(async () => {
        screen.unmount();
      });
      a.sync.setForeground(false);
      b.sync.setForeground(false);
    }, 30000);
    it('restarts while waiting, resumes lost acknowledgement/network and finishes an interrupted owner approval without another human action', async () => {
      const a = await owner(),
        b = await client('android'),
        { link } = await a.sync.createInvitation();
      const realFetch = globalThis.fetch;
      let lost = false;
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          const response = await realFetch(input, init);
          if (String(input).endsWith('/request') && !lost) {
            lost = true;
            throw new Error('synthetic_lost_ack');
          }
          return response;
        });
      try {
        await expect(b.sync.connectInvitation(link)).rejects.toThrow(
          'synthetic_lost_ack',
        );
      } finally {
        network.mockRestore();
      }
      await b.restart();
      await expect
        .poll(() => b.profile().pairingSubmitted, { timeout: 15000 })
        .toBe(true);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      const target = b.profile().profile!.deviceId;
      let dropped = false;
      const interruption = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input, init) => {
          if (String(input).endsWith('/deliveries') && !dropped) {
            dropped = true;
            throw new Error('synthetic_network_loss');
          }
          return realFetch(input, init);
        });
      try {
        await expect(a.sync.approve(target)).rejects.toThrow(
          'synthetic_network_loss',
        );
      } finally {
        interruption.mockRestore();
      }
      expect(a.profile().approvingDevice).toBe(target);
      await a.restart();
      await expect
        .poll(async () => (await b.sync.status()).phase, { timeout: 15000 })
        .toBe('bound');
      await expect
        .poll(() => b.sync.coordinator.lastCompletedAt, { timeout: 15000 })
        .toBeTruthy();
      expect(await b.rows()).toMatchObject([
        { description: 'E2EE pairing canary 🦁' },
      ]);
      expect(b.login).not.toHaveBeenCalled();
      a.sync.setForeground(false);
      b.sync.setForeground(false);
    }, 30000);
    it('keeps rotation, revocation and recovery operational after capability pairing', async () => {
      const a = await owner(),
        b = await client('android'),
        { link } = await a.sync.createInvitation();
      await b.sync.connectInvitation(link);
      await expect
        .poll(async () => (await a.sync.status()).pairingRequests.length, {
          timeout: 15000,
        })
        .toBe(1);
      await a.sync.approve(b.profile().profile!.deviceId);
      await expect
        .poll(async () => (await b.sync.status()).phase, { timeout: 15000 })
        .toBe('bound');
      await b.sync.sync();
      const before = (await b.sync.status()).activeKeyVersion;
      await a.sync.rotateKeys();
      await b.sync.sync();
      expect((await b.sync.status()).activeKeyVersion).toBeGreaterThan(before);
      const code = await a.sync.generateRecovery();
      await a.sync.confirmRecovery(code.code);
      expect((await a.sync.status()).recoveryVersion).not.toBe('0');
      const own = b.profile().profile!;
      await a.sync.revoke(own.deviceId, own.deviceId);
      await expect(b.sync.sync()).rejects.toThrow('device_revoked');
      a.sync.setForeground(false);
      b.sync.setForeground(false);
    }, 30000);
  },
);
