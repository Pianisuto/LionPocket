import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import {
  secretContext,
  type EpochPreparationSecretScope,
  type SecretScope,
} from "@lionpocket/sync-local";
const bridge = vi.hoisted(() => ({
  values: new Map<string, string>(),
  store: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({
  NativeModules: { LionPocketSecrets: bridge },
}));
vi.mock("./crypto", async () => ({
  androidCrypto: async () => (await import("libsodium-wrappers-sumo")).default,
}));
import { AndroidSecretStore } from "./secretStore";
beforeAll(async () => {
  await sodium.ready;
});
afterEach(() => {
  bridge.values.clear();
  vi.resetAllMocks();
});
function setup() {
  const scope: EpochPreparationSecretScope = {
    formatVersion: 1,
    purpose: "epochPreparation",
    installationId: randomUUID(),
    anchorDeviceId: randomUUID(),
    serverId: randomUUID(),
    vaultId: randomUUID(),
    fromEpoch: randomUUID(),
    toEpoch: randomUUID(),
    restoreId: randomUUID(),
  };
  bridge.store.mockImplementation(async (aad: string, bytes: string) => {
    const existing = bridge.values.get(aad);
    if (
      JSON.parse(aad).purpose === "epochPreparation" &&
      existing &&
      existing !== bytes
    )
      throw new Error("Preparation secret is immutable.");
    bridge.values.set(aad, bytes);
  });
  bridge.load.mockImplementation(
    async (aad: string) => bridge.values.get(aad) ?? null,
  );
  bridge.remove.mockImplementation(async (aad: string) => {
    bridge.values.delete(aad);
  });
  return { scope, store: new AndroidSecretStore() };
}
it("Android bridge roundtrips variable preparation bytes through new adapters and keeps domain isolation", async () => {
  const { scope, store } = setup(),
    bytes = sodium.randombytes_buf(4096);
  await store.store(scope, bytes);
  const loaded = await new AndroidSecretStore().load(scope);
  expect(loaded !== null && sodium.memcmp(loaded, bytes)).toBe(true);
  expect(JSON.parse(bridge.store.mock.calls[0][0]).context).toBe(
    "LionPocket/epoch-preparation-wrap/v1",
  );
  await expect(
    store.store(scope, sodium.randombytes_buf(4096)),
  ).rejects.toThrow("immutable");
  expect(await store.load({ ...scope, restoreId: randomUUID() })).toBeNull();
  bytes.fill(0);
  loaded?.fill(0);
});
it("Android wrapper rejects oversized, malformed and operational variable-length secrets before native storage", async () => {
  const { scope, store } = setup();
  for (const length of [0, 131073])
    await expect(store.store(scope, new Uint8Array(length))).rejects.toThrow(
      "size",
    );
  const operational: SecretScope = {
    installationId: scope.installationId,
    deviceId: scope.anchorDeviceId,
    serverId: scope.serverId,
    serverEpoch: scope.fromEpoch,
    vaultId: scope.vaultId,
    purpose: "signingSeed",
    keyVersion: 1,
  };
  await expect(store.store(operational, new Uint8Array(64))).rejects.toThrow(
    "32-byte",
  );
  expect(bridge.store).not.toHaveBeenCalled();
  bridge.values.set(secretContext(scope), "PRIVATE_PREPARATION_CANARY=");
  await expect(store.load(scope)).rejects.toThrow("Invalid wrapped secret.");
});
it("native failures remain failures with no fallback storage", async () => {
  const { scope, store } = setup();
  bridge.store.mockRejectedValue(new Error("System secret storage failed."));
  await expect(store.store(scope, new Uint8Array(64))).rejects.toThrow(
    "System secret storage failed.",
  );
  expect(await store.load(scope)).toBeNull();
});
