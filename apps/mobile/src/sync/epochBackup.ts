import { open, type NitroSQLiteConnection } from "react-native-nitro-sqlite";
import { assertBase64Url } from "@lionpocket/sync-protocol";
import { verifyAnchorPlanBackup, type SqlRow } from "@lionpocket/sync-local";
import { localFiles } from "../files/native";

/** Immutable app-private snapshots, independently reopened READ ONLY with integrity and causal-plan checks. */
export function mobileEpochBackup(db: NitroSQLiteConnection) {
  const inspect = async (path: string) => {
    const name = path.split("/").at(-1)!;
    const fingerprint = await localFiles.fingerprintBackup(name, false);
    assertBase64Url(fingerprint.sha256, 32);
    if (fingerprint.path !== path) throw new Error("epoch_backup_invalid");
    const backup = open({
      name,
      location: "backups",
      connection: "independent",
      readOnly: true,
    });
    const read = async (sql: string, params?: (string | number | null)[]) =>
      (await backup.executeAsync<SqlRow>(sql, params)).rows._array;
    try {
      const integrity = await read("PRAGMA integrity_check"),
        fks = await read("PRAGMA foreign_key_check");
      if (
        integrity.length !== 1 ||
        integrity[0].integrity_check !== "ok" ||
        fks.length
      )
        throw new Error("epoch_backup_invalid");
      await verifyAnchorPlanBackup({ read });
      const [binding] = await read(
        "SELECT pin_json FROM sync_bindings WHERE binding_id=(SELECT binding_id FROM sync_local_state WHERE id=1)",
      );
      if (!binding?.pin_json) throw new Error("epoch_backup_invalid");
      return {
        sha256: fingerprint.sha256,
        integrity: "ok" as const,
        foreignKeyViolations: 0,
        bindingPinJson: String(binding.pin_json),
      };
    } finally {
      backup.close();
    }
  };
  return {
    create: async () => {
      const file = await localFiles.prepareFile("backups", "sqlite");
      await db.executeAsync("VACUUM INTO ?", [file.path]);
      const sealed = await localFiles.fingerprintBackup(file.name, true);
      const inspected = await inspect(file.path);
      if (sealed.path !== file.path || sealed.sha256 !== inspected.sha256)
        throw new Error("epoch_backup_invalid");
      return { path: file.path, sha256: inspected.sha256 };
    },
    inspect,
    inspectCheckpoint: async (path: string, restoreId: string) => {
      const inspected = await inspect(path);
      const backup = open({
        name: path.split("/").at(-1)!,
        location: "backups",
        connection: "independent",
        readOnly: true,
      });
      try {
        const [row] = (
          await backup.executeAsync<SqlRow>(
            "SELECT request_sha256,phase FROM recovery_activation_saga WHERE restore_id=?",
            [restoreId],
          )
        ).rows._array;
        if (!row) throw new Error("epoch_checkpoint_invalid");
        return {
          sha256: inspected.sha256,
          requestSha256: String(row.request_sha256),
          phase: String(row.phase),
        };
      } finally {
        backup.close();
      }
    },
  };
}
