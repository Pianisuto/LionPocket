import { afterEach, expect, it, vi } from 'vitest';
import { discoverOidc } from './oidc-discovery';
import { normalizeEndpoint } from './sync';
afterEach(() => vi.unstubAllGlobals());
const issuer = 'https://auth.fixture.test/realms/lionpocket';
const good = { issuer, code_challenge_methods_supported: ['S256'], authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token', jwks_uri: issuer + '/certs' };
it('normal onboarding accepts only a root HTTPS URL, with canonical origin', () => {
  expect(normalizeEndpoint('  https://SYNC.fixture.test/  ')).toBe('https://sync.fixture.test');
  for (const url of ['http://127.0.0.1:8787', 'http://remote.test', 'https://u:p@server.test', 'https://server.test/path', 'https://server.test/?q=x', 'https://server.test/#fragment']) expect(() => normalizeEndpoint(url)).toThrow();
  expect(normalizeEndpoint('http://127.0.0.1:8787', true)).toBe('http://127.0.0.1:8787');
  expect(() => normalizeEndpoint('http://remote.test', true)).toThrow();
});
it('OIDC discovery has no credentials, uses no redirects and pins issuer/PKCE and endpoint origin', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(good)));
  vi.stubGlobal('fetch', fetch);
  expect(await discoverOidc(issuer)).toEqual({ authorizationEndpoint: good.authorization_endpoint, tokenEndpoint: good.token_endpoint, jwksUri: good.jwks_uri });
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
  for (const delta of [{ issuer: issuer + '-other' }, { code_challenge_methods_supported: ['plain'] }, { token_endpoint: 'https://other.fixture.test/token' }, { authorization_endpoint: 'http://auth.fixture.test/auth' }, { jwks_uri: 'https://auth.fixture.test/realms/other/certs' }, { token_endpoint: issuer + '/token?q=leak' }]) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...good, ...delta })));
    await expect(discoverOidc(issuer)).rejects.toThrow();
  }
});
