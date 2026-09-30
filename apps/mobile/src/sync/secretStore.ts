import { NativeModules } from 'react-native';
import {
  secretContext,
  type SecretScope,
  type SecretStore,
} from '@lionpocket/sync-local';
import { androidCrypto } from './crypto';
const native = NativeModules.LionPocketSecrets as {
  store(context: string, secret: string): Promise<void>;
  load(context: string): Promise<string | null>;
  remove(context: string): Promise<void>;
};
export class AndroidSecretStore implements SecretStore {
  async store(scope: SecretScope, secret: Uint8Array): Promise<void> {
    if (secret.length !== 32)
      throw new Error('Expected a 32-byte seed or data key.');
    const crypto = await androidCrypto();
    await native.store(
      secretContext(scope),
      crypto.to_base64(secret, crypto.base64_variants.URLSAFE_NO_PADDING),
    );
  }
  async load(scope: SecretScope): Promise<Uint8Array | null> {
    const crypto = await androidCrypto();
    const encoded = await native.load(secretContext(scope));
    if (encoded === null) return null;
    const secret = crypto.from_base64(
      encoded,
      crypto.base64_variants.URLSAFE_NO_PADDING,
    );
    if (
      secret.length !== 32 ||
      crypto.to_base64(secret, crypto.base64_variants.URLSAFE_NO_PADDING) !==
        encoded
    )
      throw new Error('Invalid wrapped secret.');
    return secret;
  }
  async remove(scope: SecretScope): Promise<void> {
    await native.remove(secretContext(scope));
  }
}
