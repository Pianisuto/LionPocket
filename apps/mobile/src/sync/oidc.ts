import { NativeModules, Platform } from 'react-native';
import { authorize } from 'react-native-app-auth';
import { androidCrypto } from './crypto';

/** Isolated development harness only; system Custom Tab + AppAuth state/PKCE. No session persistence. */
export async function androidDevelopmentOidc() {
  if (Platform.OS !== 'android' || !NativeModules.CryptoSpikeReport)
    throw new Error(
      'OIDC development login requires the synthetic Android harness.',
    );
  const issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
  const clientId = 'lionpocket-android-dev';
  const sodium = await androidCrypto();
  const nonce = sodium.to_base64(
    sodium.randombytes_buf(32),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  const session = await authorize({
    issuer,
    clientId,
    redirectUrl: 'com.lionpocketmobile.syncdev:/callback',
    scopes: ['openid'],
    usePKCE: true,
    useNonce: true,
    skipCodeExchange: false,
    additionalParameters: { prompt: 'login', nonce },
    dangerouslyAllowInsecureHttpRequests: true,
    connectionTimeoutSeconds: 15,
  });
  const response = await fetch(issuer + '/protocol/openid-connect/certs');
  if (!response.ok) throw new Error('OIDC public keys unavailable.');
  const jwks = await response.text();
  const native = NativeModules.LionPocketIdentity as {
    verify(
      token: string,
      jwks: string,
      issuer: string,
      audience: string,
      clientId: string,
      nonce: string | null,
      access: boolean,
    ): Promise<string>;
  };
  const subject = await native.verify(
    session.idToken,
    jwks,
    issuer,
    clientId,
    clientId,
    nonce,
    false,
  );
  const accessSubject = await native.verify(
    session.accessToken,
    jwks,
    issuer,
    'lionpocket-sync-api',
    clientId,
    null,
    true,
  );
  if (subject !== accessSubject || session.tokenType !== 'Bearer')
    throw new Error('OIDC identity mismatch.');
  return { accessToken: session.accessToken, issuer, subject };
}
