import { discoverOidc, syncFetchText } from '@lionpocket/sync-local';
import { NativeModules, Platform } from 'react-native';
import { authorize } from 'react-native-app-auth';
import { installAndroidSyncTransport } from './network';
import { androidCrypto } from './crypto';

/** Generic system Custom Tab + AppAuth state/PKCE. Sessions remain in memory. */
export async function androidOidc(configured?: {issuer:string;androidClientId:string;androidRedirect:string}) {
  if (Platform.OS !== 'android' || (!configured && !NativeModules.CryptoSpikeReport))
    throw new Error(
      'OIDC development login requires the synthetic Android harness.',
    );
  const issuer = configured?.issuer ?? 'http://127.0.0.1:18080/realms/lionpocket-dev';
  const clientId = configured?.androidClientId ?? 'lionpocket-android-dev';
  if (configured && configured.androidRedirect !== (NativeModules.LionPocketIdentity?.privateBeta ? 'com.lionpocketmobile.beta:/callback' : 'com.lionpocketmobile:/callback'))
    throw new Error('Invalid Android callback.');
  installAndroidSyncTransport();
  const discovery = await discoverOidc(issuer, !configured);
  const sodium = await androidCrypto();
  const nonce = sodium.to_base64(
    sodium.randombytes_buf(32),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  const session = await authorize({
    issuer,
    serviceConfiguration: { authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint },
    clientId,
    redirectUrl: configured?.androidRedirect ?? 'com.lionpocketmobile.syncdev:/callback',
    scopes: ['openid'],
    usePKCE: true,
    useNonce: true,
    skipCodeExchange: true,
    additionalParameters: { prompt: 'login', nonce },
    dangerouslyAllowInsecureHttpRequests: !configured,
    connectionTimeoutSeconds: 15,
  });
  if (!session.authorizationCode || !session.codeVerifier) throw new Error('OIDC code missing.');
  const tokenResponse = await syncFetchText(discovery.tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      redirect_uri: configured?.androidRedirect ?? 'com.lionpocketmobile.syncdev:/callback',
      code: session.authorizationCode, code_verifier: session.codeVerifier }).toString(),
  });
  if (!tokenResponse.ok || tokenResponse.text.length > 65536) throw new Error('OIDC code exchange rejected.');
  const tokens = JSON.parse(tokenResponse.text) as { access_token: string; id_token: string; token_type: string; expires_in: number };
  if (!tokens.access_token || !tokens.id_token || tokens.token_type !== 'Bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Invalid OIDC response.');
  const response = await syncFetchText(discovery.jwksUri);
  if (!response.ok) throw new Error('OIDC public keys unavailable.');
  const jwks = response.text;
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
    tokens.id_token,
    jwks,
    issuer,
    clientId,
    clientId,
    nonce,
    false,
  );
  const accessSubject = await native.verify(
    tokens.access_token,
    jwks,
    issuer,
    'lionpocket-sync-api',
    clientId,
    null,
    true,
  );
  if (subject !== accessSubject || tokens.token_type !== 'Bearer')
    throw new Error('OIDC identity mismatch.');
  const claims = JSON.parse(sodium.to_string(sodium.from_base64(tokens.access_token.split('.')[1], sodium.base64_variants.URLSAFE_NO_PADDING)));
  return { accessToken: tokens.access_token, issuer, subject, expiresAt: claims.exp * 1000 };
}

/** Compatibility alias; unconfigured calls still require the isolated synthetic harness. */
export const androidDevelopmentOidc = androidOidc;
