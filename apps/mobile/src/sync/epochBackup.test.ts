import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sqliteTestConnection } from "../db/sqliteTestConnection";
import { migrate } from "../db/migrations";
import { mobileEpochBackup } from "./epochBackup";
const fixture = vi.hoisted(() => ({
  directory: "",
  opens: [] as { readOnly?: boolean; connection?: string; location?: string }[],
}));
vi.mock("react-native-nitro-sqlite", () => ({
  open: (options: {
    name: string;
    readOnly?: boolean;
    connection?: string;
    location?: string;
  }) => {
    fixture.opens.push(options);
    const connection = sqliteTestConnection(
      join(fixture.directory, options.name),
    );
    return { ...connection.db, close: () => connection.sqlite.close() };
  },
}));
vi.mock("../files/native", () => ({
  localFiles: {
    prepareFile: async () => {
      const name = randomUUID() + ".sqlite";
      return { name, path: join(fixture.directory, name), location: "backups" };
    },
    fingerprintBackup: async (name: string) => ({
      name,
      path: join(fixture.directory, name),
      sha256: createHash("sha256")
        .update(readFileSync(join(fixture.directory, name)))
        .digest("base64url"),
    }),
  },
}));
afterEach(() => {
  if (fixture.directory)
    rmSync(fixture.directory, { force: true, recursive: true });
  fixture.opens = [];
});
it("reopens the real standalone snapshot, validates the pin and post-activation journal, and rejects path mismatch", async () => {
  fixture.directory = mkdtempSync(join(tmpdir(), "lp-mobile-epoch-backup-"));
  const source = sqliteTestConnection(join(fixture.directory, "source.sqlite"));
  try {
    await migrate(source.db);
    source.sqlite.exec(
      "INSERT INTO sync_bindings VALUES('binding','scope','https://fixture.invalid','server','epoch','vault','device','PIN','[]','{}'); UPDATE sync_local_state SET binding_id='binding'; CREATE TABLE recovery_activation_saga(restore_id TEXT,request_sha256 TEXT,phase TEXT); INSERT INTO recovery_activation_saga VALUES('restore','REQUEST_DIGEST','remote_active');",
    );
    const backup = mobileEpochBackup(source.db),
      created = await backup.create();
    expect((await backup.inspect(created.path)).bindingPinJson).toBe("PIN");
    expect(await backup.inspectCheckpoint(created.path, "restore")).toEqual({
      sha256: created.sha256,
      requestSha256: "REQUEST_DIGEST",
      phase: "remote_active",
    });
    expect(
      fixture.opens.every(
        (o) =>
          o.readOnly &&
          o.connection === "independent" &&
          o.location === "backups",
      ),
    ).toBe(true);
    await expect(
      backup.inspect("/different/" + basename(created.path)),
    ).rejects.toThrow("epoch_backup_invalid");
  } finally {
    source.sqlite.close();
  }
});
