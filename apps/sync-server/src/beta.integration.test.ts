import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { canonicalStringify } from "@lionpocket/sync-protocol";
import pg from "pg";
import sodium from "libsodium-wrappers-sumo";
import {
  BetaSync,
  DeviceProvisioning,
  ManualSync,
  fetchSyncHttp,
  ProvisioningCrypto,
  validateSyncBackup,
  syncTables,
  type BetaSaved,
  type BetaSession,
  type SqlRow,
} from "@lionpocket/sync-local";
import { LionPocketDatabase } from "../../desktop/src/main/database";
import { loginDevelopmentOidc } from "../../desktop/src/main/sync/oidc";
import { controlServer, initialize } from "./server";
import { controlSchema, commitSchema, bindingSchema } from "./schema";
import { keycloakIdentity } from "./identity";
import { TestSecrets, syntheticBrowserLogin } from "./testSupport";
import type { Server } from "node:http";
const enabled = process.env.LIONPOCKET_SYNC_INTEGRATION === "1";
describe.skipIf(!enabled)(
  "beta controllers against real isolated PostgreSQL and Keycloak",
  () => {
    const database = "lion_beta_" + randomUUID().replaceAll("-", ""),
      endpoint = "http://127.0.0.1:18774",
      issuer = "http://127.0.0.1:18080/realms/lionpocket-dev",
      banks: LionPocketDatabase[] = [],
      controllers: BetaSync[] = [];
    let pool: pg.Pool, admin: pg.Pool, server: Server, sessions: BetaSession[];
    let environment: { serverId: string; serverEpoch: string };
    beforeAll(async () => {
      await sodium.ready;
      admin = new pg.Pool({
        connectionString:
          "postgresql://liondev:liondev@127.0.0.1:55432/postgres",
      });
      await admin.query(`CREATE DATABASE ${database}`);
      pool = new pg.Pool({
        connectionString: `postgresql://liondev:liondev@127.0.0.1:55432/${database}`,
      });
      await pool.query(controlSchema + commitSchema + bindingSchema);
      environment = await initialize(pool);
      server = controlServer({
        pool,
        crypto: new ProvisioningCrypto(sodium),
        environment,
        origin: endpoint,
        identity: keycloakIdentity(issuer),
        financialEnabled: true,
        privateBeta: true,
        oidc: {
          issuer,
          desktopClientId: "lionpocket-desktop-dev",
          androidClientId: "lionpocket-android-dev",
          desktopRedirect: "http://127.0.0.1:18761/callback",
          androidRedirect: "com.lionpocketmobile.syncdev:/callback",
        },
      });
      await new Promise<void>((r) => server.listen(18774, "127.0.0.1", r));
      sessions = [];
      for (let i = 0; i < 2; i++)
        sessions.push(
          await loginDevelopmentOidc("lionpocket-desktop-dev", (url) =>
            syntheticBrowserLogin(url),
          ),
        );
    }, 30000);
    afterAll(async () => {
      controllers.forEach(c => c.coordinator.dispose());
      banks.forEach((b) => b.db.close());
      if (server) await new Promise<void>((r) => server.close(() => r()));
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.end();
      }
    });
    function client(session = 0, previous = false) {
      const Controller: typeof BetaSync = previous
        ? createRequire(import.meta.url)(process.env.LIONPOCKET_PREVIOUS_CLIENT!).BetaSync
        : BetaSync;
      const bank = new LionPocketDatabase(":memory:");
      banks.push(bank);
      bank.db.exec(
        "DELETE FROM categories; DELETE FROM payment_methods; DELETE FROM cards;",
      );
      let saved: BetaSaved | null = null;
      const secrets = new TestSecrets();
      const options: ConstructorParameters<typeof BetaSync>[0] = {
        allowLocalDevelopment: true,
        requireRecoveryConfirmation: false,
        db: bank.syncDatabase(),
        secrets,
        sodium,
        dialect: "desktop",
        storage: {
          load: async () => (saved ? structuredClone(saved) : null),
          save: async (s) => {
            saved = structuredClone(s);
          },
        },
        backup: async () => "/private/synthetic-backup.sqlite",
        login: async () => sessions[session],
      };
      const sync = new Controller(options);
      bank.onLocalSyncWrite(() => sync.localWriteCommitted());
      controllers.push(sync);
      sync.setForeground(true);
      return { bank, sync, secrets, options, profile: () => saved };
    }
    it.skipIf(!process.env.LIONPOCKET_PREVIOUS_CLIENT)("released v0.3.11 stops before discovery writes and preserves an already-bound bank with prepared pending data", async () => {
      const Old = createRequire(import.meta.url)(process.env.LIONPOCKET_PREVIOUS_CLIENT!);
      const fresh = client(0, true);
      await expect(fresh.sync.configure(endpoint)).rejects.toThrow('unsupported_version');
      expect(fresh.profile()).toBeNull();
      const current = client();
      await current.sync.configure(endpoint);
      await current.sync.create();
      await current.sync.sync();
      current.sync.setForeground(false);
      current.bank.saveTransaction({ kind: 'expense', description: 'Pending on the old installation',
        plannedAmount: 42, dueDate: '2026-10-04', status: 'planned' });
      const device = new DeviceProvisioning(current.profile()!.profile!, current.secrets, new ProvisioningCrypto(sodium));
      const manual = new ManualSync(current.bank.syncDatabase(), device, sodium, 'desktop', endpoint);
      const pending = current.bank.db.prepare("SELECT * FROM sync_outbox WHERE state='pending' ORDER BY length(local_seq),local_seq DESC LIMIT 1").get()!;
      await manual.prepare(String(pending.commit_id));
      const old = new Old.BetaSync(current.options) as BetaSync;
      controllers.push(old);
      old.setForeground(true);
      const snapshot = () => Object.fromEntries([...syncTables, 'transactions'].map(table => [table, current.bank.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const before = snapshot(), saved = current.profile();
      const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM sync_commits) AS commits,
        (SELECT count(*) FROM sync_http_nonces) AS nonces, (SELECT count(*) FROM sync_grants) AS grants`)).rows;
      const serverBefore = await counts();
      await expect(old.sync()).rejects.toThrow('unsupported_version');
      await expect(old.requests()).rejects.toThrow('unsupported_version');
      expect(snapshot()).toEqual(before);
      expect(current.profile()).toEqual(saved);
      expect(await counts()).toEqual(serverBefore);
      // Even an engine that bypasses discovery and reuses a prepared envelope
      // cannot read/write after the server upgrade. The old HTTP code sends no v2 header.
      const token = sessions[0].accessToken;
      const target = `/v1/vaults/${device.profile.pin.vaultId}/commits`;
      const body = String(current.bank.db.prepare('SELECT envelope_json FROM sync_outbox WHERE commit_id=?').get(pending.commit_id)!.envelope_json);
      const proof = await device.proof('POST', target, endpoint, body, token);
      await expect(Old.fetchSyncHttp(endpoint).request(target, body,
        device.crypto.encode(new TextEncoder().encode(canonicalStringify(proof))), token)).rejects.toThrow('client_upgrade_required');
      expect(snapshot()).toEqual(before);
      expect(await counts()).toEqual(serverBefore);
      const oldEngine = new Old.ManualSync(current.bank.syncDatabase(), device, sodium, 'desktop', endpoint);
      await expect(oldEngine.sync(token)).rejects.toThrow('client_upgrade_required');
      expect(snapshot()).toEqual(before);
      expect(await counts()).toEqual(serverBefore);
      // The refused proof was not consumed; a compatible transport may use it.
      await fetchSyncHttp(endpoint).request(target, body,
        device.crypto.encode(new TextEncoder().encode(canonicalStringify(proof))), token);
      old.setForeground(false);
      // Updating the app resumes exactly that bank and exactly that prepared commit.
      current.sync.setForeground(true);
      await current.sync.sync();
      expect((await current.sync.status()).sync?.pending).toBe(0);
    }, 30000);
    it("creates, pairs, automatically adopts, synchronizes, rotates/reemits and recovers through the app commands", async () => {
      const a = client(),
        b = client(1);
      await a.sync.configure(endpoint);
      const first = await a.sync.create();
      expect(first.phase).toBe("bound");
      const invite = await b.sync.inspectInvitation(first.invitation);
      await b.sync.pair(first.invitation, invite.fingerprint);
      const request = (await a.sync.requests()).requests[0];
      await a.sync.approve(request.deviceId, request.fingerprint);
      await b.sync.receive();
      expect((await b.sync.status()).reviews).toEqual([]);
      await b.sync.sync();

      a.bank.createCatalogItem({
        type: "category",
        name: "Beta 🦁",
        kind: "expense",
      });
      const cat = a.bank.getCatalogs().categories[0];
      a.bank.saveTransaction({
        kind: "expense",
        description: "FINANCIAL SECRET CANARY 🦁",
        plannedAmount: 12.34,
        actualAmount: 0,
        dueDate: "2026-10-02",
        settledDate: "2026-10-02",
        status: "paid",
        categoryId: cat.id,
      });
      await a.sync.sync();
      await b.sync.sync();
      expect(b.bank.listTransactions({ month: "2026-10" })).toMatchObject([
        {
          description: "FINANCIAL SECRET CANARY 🦁",
          actualAmount: 0,
          categoryName: "Beta 🦁",
        },
      ]);
      const r = await a.sync.generateRecovery();
      await a.sync.confirmRecovery(r.code);
      a.bank.saveTransaction({
        kind: "income",
        description: "OFFLINE pending",
        plannedAmount: 0,
        dueDate: "2026-10-03",
        status: "planned",
      });
      const pending = a.bank.db
        .prepare(
          "SELECT commit_id FROM sync_outbox WHERE state='pending' ORDER BY length(local_seq) DESC,local_seq DESC LIMIT 1",
        )
        .get();
      const engine = new ManualSync(
        a.bank.syncDatabase(),
        new DeviceProvisioning(
          a.profile()!.profile!,
          a.secrets,
          new ProvisioningCrypto(sodium),
        ),
        sodium,
        "desktop",
        endpoint,
      );
      const prepared = await engine.prepare(String(pending?.commit_id));
      await a.sync.rotateKeys();
      await a.sync.sync();
      expect(
        a.bank.db
          .prepare("SELECT envelope_json FROM sync_outbox WHERE commit_id=?")
          .get(String(pending?.commit_id))?.envelope_json,
      ).toBe(prepared);
      validateSyncBackup(
        a.bank.exportData(true) as unknown as Record<string, SqlRow[]>,
      );
      await b.sync.sync();
      expect(b.bank.listTransactions({ month: "2026-10" })).toHaveLength(2);
      expect(
        a.bank.db
          .prepare(
            "SELECT count(*) AS n FROM sync_review WHERE reason='reemission_provenance'",
          )
          .get()?.n,
      ).toBeGreaterThan(0);
      const c = client();
      const recovered = await c.sync.recover(
        first.invitation,
        invite.fingerprint,
        r.code,
      );
      expect(recovered.owner).toBe(true);
      await c.sync.sync();
      expect(c.bank.listTransactions({ month: "2026-10" })).toHaveLength(2);

      await c.sync.revoke(
        b.profile()!.profile!.deviceId,
        b.profile()!.profile!.deviceId,
      );
      await expect(b.sync.sync()).rejects.toThrow("device_revoked");
      const remote = (
        await pool.query("SELECT envelope_text FROM sync_commits")
      ).rows
        .map((r) => r.envelope_text)
        .join("");
      expect(remote).not.toContain("FINANCIAL SECRET CANARY");
      expect(remote).not.toContain("Beta 🦁");
      expect(remote).not.toContain(r.code);
      expect((await a.sync.status()).activeKeyVersion).toBeGreaterThan(1);
    }, 30000);
    it("automatically transports rapid committed financial edits through real PostgreSQL/Keycloak", async () => {
      const a = client();
      await a.sync.configure(endpoint);
      await a.sync.create();
      await a.sync.sync();
      const previous = a.sync.coordinator.lastCompletedAt;
      const completed = new Promise<void>((resolve) => {
        const remove = a.sync.subscribe(() => {
          if (!a.sync.coordinator.running && a.sync.coordinator.lastCompletedAt !== previous) {
            remove();
            resolve();
          }
        });
      });
      const tx = a.bank.saveTransaction({ kind: "expense", description: "Automatic integration", plannedAmount: 12.34, dueDate: "2026-10-02", status: "planned" });
      a.bank.saveTransaction({ id: tx.id, kind: "expense", description: "Automatic edited", plannedAmount: 12.34, dueDate: "2026-10-02", status: "planned" });
      a.bank.setTransactionPriority({ month: "2026-10", transactionId: tx.id, pinned: true });
      a.bank.settleTransaction(tx.id);
      const immutable = a.bank.db.prepare("SELECT commit_id,payload_json FROM sync_outbox ORDER BY local_seq").all();
      expect(immutable).toHaveLength(4);
      for (let i = 0; i < 10; i++) a.sync.setForeground(true);
      await completed;
      expect((await a.sync.status()).sync?.pending).toBe(0);
      expect(a.bank.db.prepare("SELECT commit_id,payload_json FROM sync_outbox ORDER BY local_seq").all()).toEqual(immutable);
      expect((await pool.query("SELECT count(*)::int AS n FROM sync_commits WHERE vault_id=$1", [a.profile()!.profile!.pin.vaultId])).rows[0].n).toBe(4);
    }, 30000);
  },
);
