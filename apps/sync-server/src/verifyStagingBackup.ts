import { readFileSync } from "node:fs";
import pg from "pg";
import sodium from "libsodium-wrappers-sumo";
import { ProvisioningCrypto } from "@lionpocket/sync-local";
import { verifyStagingBackup } from "./stagingBackup";
const database = process.argv[2];
if (!database || !/^lion_sync$|^lp_verify_sync_[a-f0-9]{32}$/.test(database))
  throw new Error("invalid_backup_database");
const pool = new pg.Pool({
  host: process.env.SYNC_DB_HOST,
  database,
  user: process.env.SYNC_DB_USER,
  password: readFileSync(process.env.SYNC_DB_PASSWORD_FILE!, "utf8").trim(),
});
pool.on("error", () => undefined);
let tx: pg.PoolClient | undefined;
try {
  await sodium.ready;
  tx = await pool.connect();
  await tx.query("BEGIN READ ONLY");
  await verifyStagingBackup(tx, new ProvisioningCrypto(sodium));
  await tx.query("COMMIT");
  console.log("Staging signatures and public graph verified.");
} catch {
  process.stderr.write("Staging backup validation failed.\n");
  process.exitCode = 1;
} finally {
  tx?.release();
  await pool.end();
}
