import { NativeModules } from "react-native";
import { BetaSync, type BetaSaved } from "@lionpocket/sync-local";
import { onLocalSyncWrite } from "../db/syncWriters";
import { database } from "../db/connection";
import { localFiles } from "../files/native";
import { mobileSyncDatabase } from "./database";
import { androidCrypto } from "./crypto";
import { AndroidSecretStore } from "./secretStore";
import { androidDevelopmentOidc } from "./oidc";
export const privateBeta = !!NativeModules.LionPocketIdentity?.privateBeta;
export const betaEndpoint: string = privateBeta ? (NativeModules.LionPocketIdentity?.betaEndpoint ?? "") : "";
let controller: Promise<BetaSync> | undefined;
export function betaSync(): Promise<BetaSync> {
  if (!privateBeta)
    return Promise.reject(new Error("Abra o app LionPocket Beta."));
  if (!controller)
    controller = (async () => {
      const db = await database();
      const beta = new BetaSync({
        db: mobileSyncDatabase(db),
        secrets: new AndroidSecretStore(),
        sodium: await androidCrypto(),
        dialect: "android",
        defaultEndpoint: betaEndpoint,
        storage: {
          load: async () => {
            const [row] = (
              await db.executeAsync<{ value: string }>(
                "SELECT value FROM local_preferences WHERE key='sync-beta-public-profile'",
              )
            ).rows._array;
            return row ? (JSON.parse(row.value) as BetaSaved) : null;
          },
          save: async (value) => {
            await db.executeAsync(
              "INSERT INTO local_preferences(key,value) VALUES('sync-beta-public-profile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [JSON.stringify(value)],
            );
          },
        },
        backup: async () => {
          const f = await localFiles.prepareFile("backups", "sqlite");
          await db.executeAsync("VACUUM INTO ?", [f.path]);
          return f.path;
        },
        login: async (e) => androidDevelopmentOidc(e.oidc),
      });
      onLocalSyncWrite(db, () => beta.localWriteCommitted());
      return beta;
    })().catch((e) => {
      controller = undefined;
      throw e;
    });
  return controller;
}
