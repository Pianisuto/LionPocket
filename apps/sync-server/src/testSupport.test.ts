import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  secretContext,
  type EpochPreparationSecretScope,
} from "@lionpocket/sync-local";
import { TestSecrets } from "./testSupport";
it("TestSecrets matches immutable preparation semantics, exact scope and variable length", async () => {
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
  const first = new TestSecrets(),
    bytes = new Uint8Array(4096).fill(7);
  await first.store(scope, bytes);
  bytes.fill(0);
  const restarted = new TestSecrets(first.values),
    read = (await restarted.load(scope))!;
  expect(read.every((b) => b === 7)).toBe(true);
  read.fill(0);
  await expect(restarted.store(scope, bytes)).rejects.toThrow("immutable");
  expect(
    await restarted.load({ ...scope, restoreId: randomUUID() }),
  ).toBeNull();
  expect(first.values.size).toBe(1);
  expect(first.values.has(secretContext(scope))).toBe(true);
});
