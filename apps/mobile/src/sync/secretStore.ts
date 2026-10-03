import { NativeModules } from "react-native";
import {
  secretContext,
  assertSecretBytes,
  type StoredSecretScope,
  type SecretStore,
} from "@lionpocket/sync-local";
import { androidCrypto } from "./crypto";
const native = NativeModules.LionPocketSecrets as {
  store(context: string, secret: string): Promise<void>;
  load(context: string): Promise<string | null>;
  remove(context: string): Promise<void>;
};
export class AndroidSecretStore implements SecretStore {
  async store(scope: StoredSecretScope, secret: Uint8Array): Promise<void> {
    assertSecretBytes(scope, secret);
    const crypto = await androidCrypto();
    await native.store(
      secretContext(scope),
      crypto.to_base64(secret, crypto.base64_variants.URLSAFE_NO_PADDING),
    );
  }
  async load(scope: StoredSecretScope): Promise<Uint8Array | null> {
    const crypto = await androidCrypto();
    const encoded = await native.load(secretContext(scope));
    if (encoded === null) return null;
    let secret: Uint8Array;
    try {
      secret = crypto.from_base64(
        encoded,
        crypto.base64_variants.URLSAFE_NO_PADDING,
      );
    } catch {
      throw new Error("Invalid wrapped secret.");
    }
    if (
      crypto.to_base64(secret, crypto.base64_variants.URLSAFE_NO_PADDING) !==
      encoded
    )
      throw new Error("Invalid wrapped secret.");
    assertSecretBytes(scope, secret);
    return secret;
  }
  async remove(scope: StoredSecretScope): Promise<void> {
    await native.remove(secretContext(scope));
  }
}
