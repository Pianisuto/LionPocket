import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), verify: vi.fn(), install: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: { LionPocketIdentity: { privateBeta: false, verify: mocks.verify } } }));
vi.mock('react-native-app-auth', () => ({ authorize: mocks.authorize }));
vi.mock('./network', () => ({ installAndroidSyncTransport: mocks.install }));
vi.mock('./crypto', async () => ({ androidCrypto: async () => (await import('libsodium-wrappers-sumo')).default }));
import { androidOidc } from './oidc';
beforeAll(() => sodium.ready);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const issuer = 'https://auth.fixture.test/realms/lionpocket';
const config = { issuer, androidClientId: 'lionpocket-android', androidRedirect: 'com.lionpocketmobile:/callback' };
it('normal Android uses discovered endpoints, stable callback and AppAuth PKCE/state before protected code exchange', async () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const access = 'fixture.' + sodium.to_base64(new TextEncoder().encode(JSON.stringify({ exp })), sodium.base64_variants.URLSAFE_NO_PADDING) + '.fixture';
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ issuer, code_challenge_methods_supported: ['S256'], authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token', jwks_uri: issuer + '/certs' }));
    if (url.endsWith('/token')) {
      expect(init.redirect).toBe('error');
      expect(new URLSearchParams(String(init.body)).get('code_verifier')).toBe('appauth-pkce-verifier');
      expect(new URLSearchParams(String(init.body)).get('client_id')).toBe(config.androidClientId);
      return new Response(JSON.stringify({ access_token: access, id_token: 'fixture-id-token', token_type: 'Bearer', expires_in: 300 }));
    }
    return new Response('{"keys":[]}');
  });
  vi.stubGlobal('fetch', fetch);
  mocks.authorize.mockResolvedValue({ authorizationCode: 'fixture-code', codeVerifier: 'appauth-pkce-verifier' });
  mocks.verify.mockResolvedValue('fixture-subject');
  const session = await androidOidc(config);
  expect(session).toMatchObject({ issuer, subject: 'fixture-subject', expiresAt: exp * 1000 });
  expect(mocks.install).toHaveBeenCalled();
  expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'lionpocket-android', redirectUrl: config.androidRedirect, usePKCE: true, useNonce: true, skipCodeExchange: true, dangerouslyAllowInsecureHttpRequests: false, serviceConfiguration: { authorizationEndpoint: issuer + '/auth', tokenEndpoint: issuer + '/token' } }));
  expect(mocks.verify).toHaveBeenNthCalledWith(1, 'fixture-id-token', '{"keys":[]}', issuer, 'lionpocket-android', 'lionpocket-android', expect.any(String), false);
  expect(mocks.verify).toHaveBeenNthCalledWith(2, access, '{"keys":[]}', issuer, 'lionpocket-sync-api', 'lionpocket-android', null, true);
});
it('normal channel refuses beta/syncdev callback and unconfigured synthetic login before AppAuth', async () => {
  for (const androidRedirect of ['com.lionpocketmobile.beta:/callback', 'com.lionpocketmobile.syncdev:/callback', 'https://other.fixture.test/callback']) await expect(androidOidc({ ...config, androidRedirect })).rejects.toThrow('callback');
  await expect(androidOidc()).rejects.toThrow('synthetic');
  expect(mocks.authorize).not.toHaveBeenCalled();
});
