import { describe, expect, it } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
} from 'jose';
import { loginDevelopmentOidc } from '../../desktop/src/main/sync/oidc';
import { verifyAccessIdentity } from './identity';
import { syntheticBrowserLogin } from './testSupport';
const issuer = 'http://127.0.0.1:18080/realms/lionpocket-dev';
it('validates issuer, subject, audience, authorized client, Bearer type and expiry with real JWT signatures', async () => {
  const pair = await generateKeyPair('RS256'),
    key = await exportJWK(pair.publicKey),
    keys = createLocalJWKSet({ keys: [{ ...key, kid: 'test' }] });
  const base = {
    iss: issuer,
    sub: 'synthetic',
    aud: 'lionpocket-sync-api',
    azp: 'lionpocket-desktop-dev',
    typ: 'Bearer',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const sign = (payload: JWTPayload) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .sign(pair.privateKey);
  expect(await verifyAccessIdentity(await sign(base), issuer, keys)).toEqual({
    issuer,
    subject: 'synthetic',
  });
  for (const delta of [
    { iss: 'http://wrong' },
    { aud: 'wrong' },
    { sub: '' },
    { azp: 'other' },
    { typ: 'ID' },
    { exp: 1 },
  ])
    await expect(
      verifyAccessIdentity(await sign({ ...base, ...delta }), issuer, keys),
    ).rejects.toThrow();
});
describe.skipIf(process.env.LIONPOCKET_SYNC_INTEGRATION !== '1')(
  'OIDC callback and PKCE against real Keycloak',
  () => {
    it('rejects forged state, duplicate code and wrong issuer before completing a valid login', async () => {
      const result = await loginDevelopmentOidc(
        'lionpocket-desktop-dev',
        async (url) => {
          const auth = new URL(url),
            callback = new URL(auth.searchParams.get('redirect_uri') as string);
          callback.search = new URLSearchParams({
            code: 'forged',
            state: 'wrong',
          }).toString();
          expect((await fetch(callback)).status).toBe(400);
          callback.search = new URLSearchParams({
            code: 'one',
            state: auth.searchParams.get('state') as string,
            iss: 'http://wrong',
          }).toString();
          expect((await fetch(callback)).status).toBe(400);
          callback.search = `code=one&code=two&state=${auth.searchParams.get('state')}`;
          expect((await fetch(callback)).status).toBe(400);
          expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
          expect(auth.searchParams.has('client_secret')).toBe(false);
          await syntheticBrowserLogin(url);
        },
        15000,
      );
      expect(result.issuer).toBe(issuer);
    });
    it('rejects a substituted ID-token nonce', async () => {
      await expect(
        loginDevelopmentOidc(
          'lionpocket-desktop-dev',
          async (url) => {
            const altered = new URL(url);
            altered.searchParams.set('nonce', 'substituted');
            await syntheticBrowserLogin(altered.toString());
          },
          15000,
        ),
      ).rejects.toThrow('OIDC identity mismatch');
    });
    it('Keycloak enforces the PKCE verifier', async () => {
      await expect(
        loginDevelopmentOidc(
          'lionpocket-desktop-dev',
          async (url) => {
            const altered = new URL(url);
            altered.searchParams.set(
              'code_challenge',
              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            );
            await syntheticBrowserLogin(altered.toString());
          },
          15000,
        ),
      ).rejects.toThrow('OIDC code exchange rejected');
    });
  },
);
