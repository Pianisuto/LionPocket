import { mobileEpochBackup } from './epochBackup';
import { NativeModules } from "react-native";
import { SyncController, type SyncSaved } from "@lionpocket/sync-local";
import { onLocalSyncWrite } from "../db/syncWriters";
import { database } from "../db/connection";
import { localFiles } from "../files/native";
import { mobileSyncDatabase } from "./database";
import { androidCrypto } from "./crypto";
import { AndroidSecretStore } from "./secretStore";
import { installAndroidSyncTransport } from "./network";
import { androidOidc } from "./oidc";
export const privateBeta = !!NativeModules.LionPocketIdentity?.privateBeta;
export const betaEndpoint: string = privateBeta ? (NativeModules.LionPocketIdentity?.betaEndpoint ?? "") : "";
let controller: Promise<SyncController> | undefined;
export function syncController(): Promise<SyncController> {
  if (!controller)
    controller = (async () => {
      installAndroidSyncTransport();
      const db = await database();
      const beta = new SyncController({
        db: mobileSyncDatabase(db),
        secrets: new AndroidSecretStore(),
        sodium: await androidCrypto(),
        dialect: "android",
        deviceName: NativeModules.LionPocketPairing?.deviceName ?? "Celular Android",
        defaultEndpoint: betaEndpoint,
        storage: {
          load: async () => {
            const [row] = (
              await db.executeAsync<{ value: string }>(
                "SELECT value FROM local_preferences WHERE key=?",
                [privateBeta ? "sync-beta-public-profile" : "sync-public-profile"],
              )
            ).rows._array;
            return row ? (JSON.parse(row.value) as SyncSaved) : null;
          },
          save: async (value) => {
            await db.executeAsync(
              "INSERT INTO local_preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [privateBeta ? "sync-beta-public-profile" : "sync-public-profile", JSON.stringify(value)],
            );
          },
        },
        epochBackup: mobileEpochBackup(db),
        backup: async () => {
          const f = await localFiles.prepareFile("backups", "sqlite");
          await db.executeAsync("VACUUM INTO ?", [f.path]);
          return f.path;
        },
        login: async (e) => androidOidc(e.oidc),
      });
      await beta.resumeRecoveryOnStartup().catch(() => {
        /* An incomplete saga excludes foreground; local financial access stays available. */
      });
      onLocalSyncWrite(db, () => beta.localWriteCommitted());
      return beta;
    })().catch((e) => {
      controller = undefined;
      throw e;
    });
  return controller;
}
