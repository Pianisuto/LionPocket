import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import React from 'react';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from 'react-test-renderer';
import { PairingOnboarding } from '../../desktop/src/ui/PairingOnboarding';
import { handlePairingInstances, PairingLinkInbox } from '../../desktop/src/main/pairingLinks';
import type { PairingLinkEvent } from '../../desktop/src/api';
import { SyncPanel as DesktopSyncPanel } from '../../desktop/src/ui/settings/sync/SyncPanel';
import { SyncPanel as MobileSyncPanel } from '../../mobile/src/ui/settings/sync/SyncPanel';
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
  inviteSigningInput,
  type HttpProof,
} from '@lionpocket/sync-protocol';
import {
  SyncController,
  DeviceProvisioning,
  ProvisioningCrypto,
  financialTableTypes,
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
  Pressable: 'mobile-pressable',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Share: { share: vi.fn() },
  Image: 'mobile-image',
  NativeModules: { LionPocketPairing: { renderQr: vi.fn(async () => 'data:image/png;base64,synthetic'), copyLink: vi.fn(async () => undefined), scan: vi.fn(async () => { throw new Error('Camera must not be needed'); }) } },
}));
vi.mock('../../mobile/src/ui/Appearance', async () => {
  const { darkColors } = await import('../../mobile/src/ui/theme');
  return { useAppearance: () => ({ colors: darkColors }) };
});
vi.mock('../../mobile/src/ui/Icon', () => ({ Icon: 'mobile-icon' }));
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
      let backupTo: (path: string) => Promise<void>;
      let savePlanning: (month: string, safetyMarginCents: number) => Promise<void>;
      let saveGoalPlan: (name: string, month: string, amountCents: number) => Promise<void>;
      if (dialect === 'desktop') {
        const bank = new LionPocketDatabase(':memory:');
        backupTo = async path => {bank.db.prepare('VACUUM INTO ?').run(path);};
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
        savePlanning = async (month, safetyMarginCents) => { bank.saveMonthlyPlanning({ month, safetyMarginCents }); };
        saveGoalPlan = async (name, month, amountCents) => {
          const goal = bank.listGoals().find(g => g.name === name) ?? bank.saveGoal({ name, targetAmount: 3000, savedAmount: 100, priority: 'medium', status: 'saving' });
          bank.saveGoalReinforcement({ goalId: goal.id, month, amountCents });
        };
      } else {
        const bank = sqliteTestConnection();
        backupTo = async path => {bank.sqlite.prepare('VACUUM INTO ?').run(path);};
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
        savePlanning = (month, safetyMarginCents) => repo.saveMonthlyPlanning({ month, safetyMarginCents });
        saveGoalPlan = async (name, month, amountCents) => {
          if (!(await repo.listGoals()).some(g => g.name === name)) await repo.saveGoal({ name, targetAmount: 3000, savedAmount: 100, priority: 'medium', status: 'saving' });
          const goal = (await repo.listGoals()).find(g => g.name === name)!;
          await repo.saveGoalReinforcement({ goalId: goal.id, month, amountCents });
        };
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
        backupTo,
        savePlanning,
        saveGoalPlan,
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
    it.each([['desktop', 'android'], ['android', 'desktop']] as const)('%s → %s syncs monthly planning via encrypted server transport, including clear and redefine', async (from, to) => {
      const a = await owner(from), b = await client(to);
      await a.savePlanning('2026-10', 50000);
      await a.savePlanning('2026-11', 30000);
      await a.sync.sync();
      await b.sync.connectInvitation((await a.sync.createInvitation()).link);
      await expect.poll(async () => (await a.sync.status()).pairingRequests.length, { timeout: 15000 }).toBe(1);
      await a.sync.approve(b.profile().profile!.deviceId);
      await expect.poll(async () => (await b.sync.status()).phase, { timeout: 15000 }).toBe('bound');
      await b.sync.sync();
      const planning = (c: typeof a) => c.options.db.read('SELECT month,safety_margin_cents FROM monthly_planning ORDER BY month');
      expect(await planning(b)).toEqual([{ month: '2026-10', safety_margin_cents: 50000 }, { month: '2026-11', safety_margin_cents: 30000 }]);
      await b.savePlanning('2026-10', 60000); await b.sync.sync(); await a.sync.sync();
      expect(await planning(a)).toEqual([{ month: '2026-10', safety_margin_cents: 60000 }, { month: '2026-11', safety_margin_cents: 30000 }]);
      await a.savePlanning('2026-10', 0); await a.sync.sync(); await b.sync.sync();
      expect((await planning(b))[0].safety_margin_cents).toBe(0);
      await b.savePlanning('2026-10', 12345); await b.sync.sync(); await a.sync.sync();
      expect(await planning(a)).toEqual(await planning(b));
      const identities = "SELECT local_id,object_id FROM sync_identity WHERE entity_type='monthlyPlanning' ORDER BY local_id";
      expect(await a.options.db.read(identities)).toEqual(await b.options.db.read(identities));
      const stored = canonicalStringify((await pool.query('SELECT * FROM sync_commits WHERE vault_id=$1', [a.profile().profile!.pin.vaultId])).rows);
      expect(stored).not.toContain('safetyMarginCents');
      expect(stored).not.toContain('monthlyPlanning');
      a.sync.setForeground(false); b.sync.setForeground(false);
    }, 30000);

    it.each([['desktop', 'android'], ['android', 'desktop']] as const)('%s → %s syncs goal monthly reinforcement via encrypted server transport with a stable identity, clear and redefine', async (from, to) => {
      const a = await owner(from), b = await client(to);
      await a.saveGoalPlan('Notebook', '2026-10', 50000);
      await a.saveGoalPlan('Notebook', '2026-11', 70000);
      await a.sync.sync();
      await b.sync.connectInvitation((await a.sync.createInvitation()).link);
      await expect.poll(async () => (await a.sync.status()).pairingRequests.length, { timeout: 15000 }).toBe(1);
      await a.sync.approve(b.profile().profile!.deviceId);
      await expect.poll(async () => (await b.sync.status()).phase, { timeout: 15000 }).toBe('bound');
      await b.sync.sync();
      const plans = (c: typeof a) => c.options.db.read('SELECT g.name,r.month,r.amount_cents FROM goal_monthly_reinforcements r JOIN goals g ON g.id=r.goal_id ORDER BY r.month');
      expect(await plans(b)).toEqual([{ name: 'Notebook', month: '2026-10', amount_cents: 50000 }, { name: 'Notebook', month: '2026-11', amount_cents: 70000 }]);
      await b.saveGoalPlan('Notebook', '2026-10', 60000); await b.sync.sync(); await a.sync.sync();
      expect((await plans(a))[0].amount_cents).toBe(60000);
      await a.saveGoalPlan('Notebook', '2026-10', 0); await a.sync.sync(); await b.sync.sync();
      expect((await plans(b))[0].amount_cents).toBe(0);
      await b.saveGoalPlan('Notebook', '2026-10', 12345); await b.sync.sync(); await a.sync.sync();
      expect(await plans(a)).toEqual(await plans(b));
      const objects = "SELECT object_id FROM sync_identity WHERE entity_type='goalMonthlyReinforcement' ORDER BY object_id";
      expect(await a.options.db.read(objects)).toEqual(await b.options.db.read(objects));
      const stored = canonicalStringify((await pool.query('SELECT * FROM sync_commits WHERE vault_id=$1', [a.profile().profile!.pin.vaultId])).rows);
      expect(stored).not.toContain('amountCents');
      expect(stored).not.toContain('goalMonthlyReinforcement');
      a.sync.setForeground(false); b.sync.setForeground(false);
    }, 30000);

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

    it('E2E ANDROID FUNDADOR → DESKTOP NOVO: share/copy → OS deep link → Conectar → Aprovar → key and first sync, without camera/manual paste/OIDC', async () => {
      const a = await owner('android'), b = await client('desktop');
      const commands: string[] = [], actions: string[] = [];
      let mobile: ReactTestRenderer | undefined, desktop: ReactTestRenderer | undefined;
      const { NativeModules, Share } = await import('react-native');
      const events = new Map<string, (...args: any[]) => void>();
      let intent: PairingLinkEvent | null = null;
      const command = async (action: string, args: unknown[]) => {
        commands.push(action);
        if (action === 'pairing-connect') return b.sync.connectInvitation(String(args[0]));
        throw new Error('Desktop must not need intermediate commands: ' + action);
      };
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('window', { lionPocket: { syncStatus: () => b.sync.status(), syncCommand: command, onSyncChanged: (f: () => void) => b.sync.subscribe(f) } });
      mobileRuntime.controller = a.sync;
      const mobileButton = (label: string) => mobile!.root.findAll(node => node.type === ('mobile-button' as unknown) && node.props.label === label)[0];
      const desktopButton = (label: string) => desktop!.root.findAllByType('button').find(node => renderedText(node) === label)!;
      const flush = async <T>(read: () => T) => { await act(async () => { /* Flush pending UI effects. */ }); return read(); };
      const inbox = new PairingLinkInbox(link => b.sync.inspectPairingInvitation(link), () => { intent = inbox.take(); });
      const open = async (link: string) => {
        events.get('second-instance')!({}, ['installed-lionpocket', link]);
        await expect.poll(() => intent).toBeTruthy();
        await act(async () => { desktop = create(React.createElement(PairingOnboarding, { intent: intent!, onCancel: () => { intent = null; } })); });
        await expect.poll(() => flush(() => !!desktopButton('Conectar'))).toBe(true);
      };
      try {
        handlePairingInstances({ requestSingleInstanceLock: () => true, quit: () => { throw new Error('Primary must remain open'); }, on: (event, f) => events.set(event, f) }, [], link => { void inbox.receive(link); }, () => { /* The test renderer has no native window to focus. */ });
        await act(async () => { mobile = create(React.createElement(MobileSyncPanel, { onChanged: async () => undefined })); });
        await expect.poll(() => flush(() => !!mobileButton('Adicionar aparelho'))).toBe(true);
        actions.push('Android: Adicionar aparelho');
        await act(async () => mobileButton('Adicionar aparelho').props.onPress());
        await expect.poll(() => flush(() => !!mobileButton('Compartilhar convite'))).toBe(true);
        actions.push('Android: Compartilhar convite / Copiar link');
        await act(async () => mobileButton('Compartilhar convite').props.onPress());
        const link = vi.mocked(Share.share).mock.calls.at(-1)![0].message!;
        await act(async () => mobileButton('Copiar link').props.onPress());
        expect(NativeModules.LionPocketPairing.copyLink).toHaveBeenLastCalledWith(link);
        expect(renderedText(mobile!.root)).not.toContain('LPV2.');
        actions.push('Desktop: abrir deep link pelo handler do SO');
        await open(link);
        expect(renderedText(desktop!.root)).toContain(new URL(endpoint).host);
        expect(desktop!.root.findAllByType('textarea')).toHaveLength(0);
        expect(desktop!.root.findAllByType('input')).toHaveLength(0);
        expect(renderedText(desktop!.root)).not.toMatch(/LPV2\.|QR|câmera|fingerprint|Conferir convite/);
        expect(b.profile()).toBeNull();
        expect((await a.sync.status()).pairingRequests).toHaveLength(0);
        // Cancelling is purely UI: no identity, request, key or access is created.
        await act(async () => desktopButton('Cancelar').props.onClick());
        expect(intent).toBeNull(); expect(b.profile()).toBeNull(); expect(commands).toEqual([]);
        await act(async () => desktop!.unmount());
        await open(link);
        actions.push('Desktop: Conectar');
        await act(async () => {
          const click = desktopButton('Conectar').props.onClick;
          click(); click(); // Rapid double click, same render.
        });
        await expect.poll(() => flush(() => !!mobileButton('Aprovar aparelho')), { timeout: 15000 }).toBe(true);
        expect(commands).toEqual(['pairing-connect']);
        const device = new DeviceProvisioning(b.profile().profile!, b.secrets, crypto);
        expect(await b.secrets.load(device.scope('dataKey'))).toBeNull();
        expect((await send(device, `/v2/pair/${b.profile().pairingInvite!.id}/status`, {})).body).toEqual({ state: 'waiting' });
        const deviceId = b.profile().profile!.deviceId;
        await Promise.all([b.sync.connectInvitation(link), b.sync.connectInvitation(link), b.sync.connectInvitation(link)]);
        expect(b.profile().profile!.deviceId).toBe(deviceId);
        expect((await a.sync.status()).pairingRequests).toHaveLength(1);
        events.get('second-instance')!({}, ['installed-lionpocket', link]);
        expect((await a.sync.status()).pairingRequests).toHaveLength(1);
        expect(renderedText(desktop!.root)).toContain((await a.sync.status()).pairingRequests[0].securityCode!);
        actions.push('Android: Aprovar aparelho');
        await act(async () => mobileButton('Aprovar aparelho').props.onPress());
        await expect.poll(() => flush(() => renderedText(desktop!.root).includes('Sincronização pronta')), { timeout: 15000 }).toBe(true);
        expect(await b.secrets.load(device.scope('dataKey'))).not.toBeNull();
        expect(await b.rows()).toMatchObject([{ description: 'E2EE pairing canary 🦁' }]);
        expect(b.login).not.toHaveBeenCalled();
        expect(NativeModules.LionPocketPairing.scan).not.toHaveBeenCalled();
        expect(actions).toHaveLength(5);
        await b.sync.connectInvitation(link); // Reopening after approval cannot create another request.
        expect(b.profile().phase).toBe('bound');
      } finally {
        await act(async () => { mobile?.unmount(); desktop?.unmount(); });
        mobileRuntime.controller = undefined; vi.unstubAllGlobals();
        a.sync.setForeground(false); b.sync.setForeground(false);
      }
    }, 30000);

    it('Desktop manual paste remains universal fallback and automatically validates without another review button', async () => {
      const a = await owner('android'), b = await client('desktop'), { link } = await a.sync.createInvitation();
      let desktop: ReactTestRenderer | undefined;
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('window', { lionPocket: { syncStatus: () => b.sync.status(), onSyncChanged: (f: () => void) => b.sync.subscribe(f), syncCommand: async (action: string, args: unknown[]) => {
        if (action === 'pairing-inspect') return b.sync.inspectPairingInvitation(String(args[0]));
        if (action === 'pairing-connect') return b.sync.connectInvitation(String(args[0]));
        throw new Error('Unexpected fallback command');
      } } });
      try {
        await act(async () => { desktop = create(React.createElement(DesktopSyncPanel, { onChanged: async () => undefined })); });
        await expect.poll(async () => { await act(async () => { /* Flush pending UI effects. */ }); return desktop!.root.findAllByProps({'aria-label':'Convite do cofre'}).length; }).toBe(1);
        await act(async () => desktop!.root.findByProps({'aria-label':'Convite do cofre'}).props.onChange({ target: { value: link } }));
        await expect.poll(async () => { await act(async () => { /* Flush pending UI effects. */ }); return renderedText(desktop!.root).includes(new URL(endpoint).host); }).toBe(true);
        const connect = desktop!.root.findAllByType('button').find(n => renderedText(n) === 'Conectar')!;
        await act(async () => connect.props.onClick());
        await expect.poll(async () => (await a.sync.status()).pairingRequests.length, { timeout: 15000 }).toBe(1);
        expect(b.login).not.toHaveBeenCalled();
      } finally {
        await act(async () => desktop?.unmount()); vi.unstubAllGlobals(); a.sync.setForeground(false); b.sync.setForeground(false);
      }
    }, 30000);

    it.each(['invalid', 'expired', 'revoked'] as const)('Desktop OS invite %s shows a friendly error and grants no access', async kind => {
      const a = await owner('android'), b = await client('desktop');
      let { link } = await a.sync.createInvitation();
      if (kind === 'invalid') link = 'lionpocket://pair/LPV2.invalid';
      if (kind === 'expired') {
        const parsed = parsePairingInvitation(link, crypto);
        const { signature: _signature, ...unsigned } = parsed.invite;
        unsigned.expiresAt = Date.now() - 1;
        const device = new DeviceProvisioning(a.profile().profile!, a.secrets, crypto);
        const authority = await a.secrets.load(device.scope('authoritySeed'));
        try { parsed.invite = { ...unsigned, signature: crypto.sign(inviteSigningInput(unsigned), authority!) }; }
        finally { crypto.erase(authority!); }
        link = pairingLink(parsed, crypto);
      }
      if (kind === 'revoked') await a.sync.cancelInvitation();
      const inbox = new PairingLinkInbox(value => b.sync.inspectPairingInvitation(value), () => { /* UI reads the validated inbox below. */ });
      await inbox.receive(link);
      let desktop: ReactTestRenderer | undefined;
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      vi.stubGlobal('window', { lionPocket: { syncStatus: () => b.sync.status(), onSyncChanged: (f: () => void) => b.sync.subscribe(f), syncCommand: (_action: string, args: unknown[]) => b.sync.connectInvitation(String(args[0])) } });
      try {
        await act(async () => { desktop = create(React.createElement(PairingOnboarding, { intent: inbox.take()!, onCancel: () => { /* No network mutation on close. */ } })); });
        const button = () => desktop!.root.findAllByType('button').find(n => renderedText(n) === 'Conectar');
        if (kind === 'revoked') {
          // Revocation is authoritative on the server, and is checked when Conectar submits the proof.
          await expect.poll(async () => { await act(async () => { /* Flush status load. */ }); return !button()?.props.disabled; }).toBe(true);
          await act(async () => button()!.props.onClick());
        } else expect(button()).toBeUndefined();
        const expected = { invalid: 'Convite inválido', expired: 'Convite expirado', revoked: 'Convite cancelado' }[kind];
        await expect.poll(async () => { await act(async () => { /* Flush rejection UI. */ }); return renderedText(desktop!.root); }).toContain(expected);
        expect(renderedText(desktop!.root)).not.toContain('LPV2.');
        expect((await a.sync.status()).pairingRequests).toHaveLength(0);
        expect(b.login).not.toHaveBeenCalled();
        if (b.profile()?.profile) {
          const device = new DeviceProvisioning(b.profile().profile!, b.secrets, crypto);
          expect(await b.secrets.load(device.scope('dataKey'))).toBeNull();
        } else expect(b.profile()).toBeNull();
      } finally {
        await act(async () => desktop?.unmount()); vi.unstubAllGlobals(); a.sync.setForeground(false); b.sync.setForeground(false);
      }
    }, 30000);

    it('rejects tampering, invalid capability, pin-only access, unsupported format pairing and replay; request recovery is idempotent with a fresh proof', async () => {
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
        b.sync.inspectPairingInvitation('unsupported.invalid'),
      ).rejects.toThrow('invite_invalid');
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
    it('rejects server substitution or stripping of capability authentication; device transport needs no fresh OIDC', async () => {
      const a = await owner(),
        b = await client('android');
      a.sync.setForeground(false);
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
      await expect(pool.query('UPDATE sync_pairings SET pairing_auth=NULL WHERE vault_id=$1 AND device_id=$2',[vaultId,deviceId])).rejects.toThrow('not-null constraint');
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
        (await send(d, `/v1/vaults/${d.profile.pin.vaultId}/recovery-fetch`, {}))
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
    it.each(['desktop','android'] as const)('%s generates durable recovery, rejects tampering/wrong code/rollback, and recovers after losing every device', async dialect => {
      const a = await owner(dialect);
      a.sync.setForeground(false); await a.sync.coordinator.cancelAndWait();
      const older = await a.sync.generateRecovery(); await a.sync.confirmRecovery(older.code);
      const vaultId = a.profile().profile!.pin.vaultId;
      const previous = (await pool.query('SELECT recovery FROM sync_vaults WHERE vault_id=$1',[vaultId])).rows[0].recovery;
      const kit = await a.sync.generateRecovery(); await a.sync.confirmRecovery(kit.code);
      expect(kit.recoveryPackage.startsWith('LPR1.')).toBe(true);
      expect(kit.recoveryPackage).not.toContain(String.fromCharCode(76,80,86,49));
      const payload = JSON.parse(new TextDecoder().decode(crypto.decode(kit.recoveryPackage.slice(5))));
      expect(Object.keys(payload).sort()).toEqual(['checkpoint','endpoint','keyVersion','pin','purpose','recoveryVersion','signature','version']);
      expect(payload).not.toHaveProperty('authoritySignSeed'); expect(payload).not.toHaveProperty('expiresAt'); expect(payload).not.toHaveProperty('capability');
      const c = await client(dialect === 'android' ? 'desktop' : 'android',true);
      c.sync.setForeground(false);
      for (const changed of [{...payload,endpoint:'https://attacker.invalid'},{...payload,pin:{...payload.pin,authorityPublicKey:crypto.nonce()}},{...payload,pin:{...payload.pin,vaultId:crypto.uuid()}}]) {
        const altered = 'LPR1.'+crypto.encode(encodeUtf8(canonicalStringify(changed)));
        await expect(c.sync.recover(altered,kit.code)).rejects.toThrow('Pacote de recuperação inválido');
        expect(c.profile()).toBeNull();
      }
      await expect(c.sync.recover(kit.recoveryPackage,'LP1.'+crypto.nonce())).rejects.toThrow('invalid_recovery_code');
      let recoveredDevice = new DeviceProvisioning(c.profile().profile!,c.secrets,crypto);
      expect(await c.secrets.load(recoveredDevice.scope('authoritySeed'))).toBeNull();
      expect(await c.secrets.load(recoveredDevice.scope('dataKey'))).toBeNull();
      const latest = (await pool.query('SELECT recovery FROM sync_vaults WHERE vault_id=$1',[vaultId])).rows[0].recovery;
      await pool.query('UPDATE sync_vaults SET recovery=$2 WHERE vault_id=$1',[vaultId,previous]);
      try { await expect(c.sync.recover(kit.recoveryPackage,older.code)).rejects.toThrow('recovery_rollback'); }
      finally {await pool.query('UPDATE sync_vaults SET recovery=$2 WHERE vault_id=$1',[vaultId,latest]);}
      // Only the separately stored package/code and account remain; no secret from an old device is shared.
      const state = await c.sync.recover(kit.recoveryPackage,kit.code);
      expect(state.phase).toBe('bound'); expect(state.owner).toBe(true);
      c.sync.setForeground(true); await c.sync.sync();
      expect(await c.rows()).toHaveLength(1);
      recoveredDevice = new DeviceProvisioning(c.profile().profile!,c.secrets,crypto);
      expect(await c.secrets.load(recoveredDevice.scope('authoritySeed'))).not.toBeNull();
      c.sync.setForeground(false);
    },30000);

    it.each(['desktop','android'] as const)('%s: source-of-truth/join-existing survive crashes, preserve complete banks and converge into one recreated vault without secondary OIDC', async dialect => {
      const a = await owner(dialect), b = await client(dialect === 'android' ? 'desktop' : 'android');
      await b.sync.connectInvitation((await a.sync.createInvitation()).link);
      await expect.poll(async () => (await a.sync.status()).pairingRequests.length,{timeout:15000}).toBe(1);
      await a.sync.approve(b.profile().profile!.deviceId);
      await expect.poll(async () => (await b.sync.status()).phase,{timeout:15000}).toBe('bound');
      await b.sync.sync(); expect(await b.rows()).toHaveLength(1);
      b.sync.setForeground(false); await b.sync.coordinator.cancelAndWait();
      a.sync.setForeground(false); await a.sync.coordinator.cancelAndWait();
      const finance = async (c = a) => Object.fromEntries(await Promise.all(Object.keys(financialTableTypes).map(async table => [table,await c.options.db.read(`SELECT * FROM ${table} ORDER BY rowid`)])));
      const before = await finance(), oldSaved = structuredClone(a.profile());
      const directory = mkdtempSync(join(tmpdir(),'lion-reset-')), nextDatabase = 'lion_reset_'+randomUUID().replaceAll('-','');
      let nextPool: pg.Pool | undefined, nextServer: Server | undefined;
      try {
        await admin.query(`CREATE DATABASE ${nextDatabase}`);
        nextPool = new pg.Pool({connectionString:`postgresql://liondev:liondev@127.0.0.1:55432/${nextDatabase}`});
        await nextPool.query(controlSchema+commitSchema+bindingSchema);
        const environment = await initialize(nextPool);
        nextServer = controlServer({pool:nextPool,crypto,environment,origin:'http://127.0.0.1:1',identity:keycloakIdentity(issuer),financialEnabled:true,
          oidc:{issuer,desktopClientId:'lionpocket-desktop-dev',androidClientId:'lionpocket-android-dev',desktopRedirect:'http://127.0.0.1:18761/callback',androidRedirect:'com.lionpocketmobile.syncdev:/callback'}});
        // Reserve an OS port, then use that exact origin for HTTP proofs.
        await new Promise<void>(resolve => nextServer!.listen(0,'127.0.0.1',resolve));
        const port = (nextServer.address() as {port:number}).port, nextEndpoint = `http://127.0.0.1:${port}`;
        await new Promise<void>(resolve => nextServer!.close(() => resolve()));
        nextServer = controlServer({pool:nextPool,crypto,environment,origin:nextEndpoint,identity:keycloakIdentity(issuer),financialEnabled:true,
          oidc:{issuer,desktopClientId:'lionpocket-desktop-dev',androidClientId:'lionpocket-android-dev',desktopRedirect:'http://127.0.0.1:18761/callback',androidRedirect:'com.lionpocketmobile.syncdev:/callback'}});
        await new Promise<void>(resolve => nextServer!.listen(port,'127.0.0.1',resolve));
        expect((await nextPool.query('SELECT count(*)::int AS n FROM sync_vaults')).rows[0].n).toBe(0);
        const backupPath = join(directory,'before-unlink.sqlite');
        const backup = vi.fn(async () => {
          expect(a.profile().profile!.pin).toEqual(oldSaved.profile!.pin);
          expect(await finance()).toEqual(before);
          await a.backupTo(backupPath);
          return backupPath;
        });
        a.options.backup = backup;
        await expect(a.sync.resetForRecreatedServer(nextEndpoint,'source-of-truth',false)).rejects.toThrow('Confirme');
        expect(backup).not.toHaveBeenCalled(); expect(a.profile()).toEqual(oldSaved);
        a.options.backup = async () => {throw new Error('backup unavailable');};
        await expect(a.sync.resetForRecreatedServer(nextEndpoint,'source-of-truth',true)).rejects.toThrow('Não foi possível preservar o backup local');
        expect(a.profile()).toEqual(oldSaved); expect(await finance()).toEqual(before);
        a.options.backup = backup;
        // Crash after the durable backed-up intent, before local unlink. Startup must resume it.
        const run = a.options.db.run;
        a.options.db.run = async () => {throw new Error('simulated crash before unlink');};
        await expect(a.sync.resetForRecreatedServer(nextEndpoint,'source-of-truth',true)).rejects.toThrow('simulated crash');
        a.options.db.run = run;
        expect(existsSync(backupPath)).toBe(true); expect(backup).toHaveBeenCalledTimes(1);
        expect(a.profile().serverReset).toEqual({phase:'pending-unlink',backupPath,intent:'source-of-truth'});
        const storedBackup = new DatabaseSync(backupPath);
        try {
          for (const table of Object.keys(financialTableTypes)) expect(storedBackup.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);
          expect(storedBackup.prepare('SELECT binding_id FROM sync_local_state').get()!.binding_id).toBeTruthy();
        } finally {storedBackup.close();}
        await a.restart(); a.sync.setForeground(false);
        await a.sync.resumeRecoveryOnStartup();
        expect(a.profile().serverReset).toEqual({phase:'ready',backupPath,intent:'source-of-truth'}); expect(a.profile().profile).toBeUndefined();
        expect((await a.sync.status()).serverReset?.intent).toBe('source-of-truth');
        expect(await finance()).toEqual(before);
        expect((await a.options.db.read('SELECT binding_id,mode FROM sync_local_state'))[0]).toMatchObject({binding_id:null,mode:'disabled'});
        a.options.backup = async () => {const path=join(directory,'before-baseline.sqlite'); await a.backupTo(path); return path;};
        a.sync.setForeground(true); await a.sync.create(); await a.sync.sync();
        expect(await finance()).toEqual(before); expect(a.profile().profile!.pin.serverId).toBe(environment.serverId);
        const secondaryBefore = await finance(b), secondaryPath = join(directory,'secondary.sqlite');
        const secondaryBackup = vi.fn(async () => {
          expect((await b.options.db.read('SELECT binding_id FROM sync_local_state'))[0].binding_id).toBeTruthy();
          expect(await finance(b)).toEqual(secondaryBefore);
          await b.backupTo(secondaryPath); return secondaryPath;
        });
        b.options.backup = secondaryBackup;
        // Crash after unlink but before saving ready: startup repeats only the same authorized unlink.
        const save = b.options.storage.save;
        b.options.storage.save = async value => {
          if (value.serverReset?.phase === 'ready') throw new Error('simulated crash after unlink');
          await save(value);
        };
        await expect(b.sync.resetForRecreatedServer(nextEndpoint,'join-existing',true)).rejects.toThrow('simulated crash');
        b.options.storage.save = save;
        expect(secondaryBackup).toHaveBeenCalledTimes(1);
        expect(b.profile().serverReset).toEqual({phase:'pending-unlink',backupPath:secondaryPath,intent:'join-existing'});
        expect((await b.options.db.read('SELECT binding_id FROM sync_local_state'))[0].binding_id).toBeNull();
        expect(await finance(b)).toEqual(secondaryBefore);
        const secondarySnapshot = new DatabaseSync(secondaryPath);
        try {
          expect(secondarySnapshot.prepare('SELECT binding_id FROM sync_local_state').get()!.binding_id).toBeTruthy();
          for (const table of Object.keys(financialTableTypes)) expect(secondarySnapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(secondaryBefore[table]);
        } finally { secondarySnapshot.close(); }
        await b.restart(); b.sync.setForeground(false); await b.sync.resumeRecoveryOnStartup();
        expect((await b.sync.status()).serverReset).toEqual({phase:'ready',backupPath:secondaryPath,intent:'join-existing'});
        expect(secondaryBackup).toHaveBeenCalledTimes(1); expect(await finance(b)).toEqual(secondaryBefore);
        await expect(b.sync.create()).rejects.toThrow('Este fluxo não cria outro cofre');
        // Reconfiguration and another restart cannot discard the choice or offer a second vault.
        await b.sync.configure(nextEndpoint); await b.restart();
        expect((await b.sync.status()).serverReset?.intent).toBe('join-existing');
        await expect(b.sync.create()).rejects.toThrow('Este fluxo não cria outro cofre');
        expect(b.login).not.toHaveBeenCalled();
        expect((await nextPool.query('SELECT count(*)::int AS n FROM sync_vaults')).rows[0].n).toBe(1);
        b.options.backup = async () => {const path=join(directory,'secondary-baseline-'+crypto.uuid()+'.sqlite'); await b.backupTo(path); return path;};
        b.sync.setForeground(true);
        await b.sync.connectInvitation((await a.sync.createInvitation()).link);
        await expect.poll(async () => (await a.sync.status()).pairingRequests.length,{timeout:15000}).toBe(1);
        await a.sync.approve(b.profile().profile!.deviceId);
        await expect.poll(async () => (await b.sync.status()).phase,{timeout:15000}).toBe('bound');
        await b.sync.sync(); await a.sync.sync(); await b.sync.sync();
        expect(await b.rows()).toHaveLength(1); expect(await a.rows()).toHaveLength(1);
        expect(b.login).not.toHaveBeenCalled();
        expect((await nextPool.query('SELECT count(*)::int AS n FROM sync_vaults')).rows[0].n).toBe(1);
        expect(b.profile().serverReset?.intent).toBe('join-existing');
        a.sync.setForeground(false); b.sync.setForeground(false);
        await a.sync.coordinator.cancelAndWait(); await b.sync.coordinator.cancelAndWait();
      } finally {
        a.sync.setForeground(false); await a.sync.coordinator.cancelAndWait();
        nextServer?.closeAllConnections(); if(nextServer) await new Promise<void>(resolve => nextServer!.close(() => resolve()));
        await nextPool?.end(); await admin.query(`DROP DATABASE IF EXISTS ${nextDatabase}`); rmSync(directory,{recursive:true,force:true});
      }
    },45000);
  },
);
