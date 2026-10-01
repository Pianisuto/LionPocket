import { syncFetchText } from './network';
/** IdP discovery never carries tokens and cannot redirect to a different issuer/origin. */
export async function discoverOidc(issuer: string, allowLocalDevelopment = false) {
  const url = new URL(issuer);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLocalDevelopment && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))
    throw new Error('Invalid OIDC issuer.');
  const response = await syncFetchText(issuer + '/.well-known/openid-configuration');
  if (!response.ok || response.text.length > 65536) throw new Error('OIDC discovery unavailable.');
  const value = JSON.parse(response.text);
  if (value.issuer !== issuer || !value.code_challenge_methods_supported?.includes('S256'))
    throw new Error('OIDC discovery incompatible.');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const endpoint = new URL(value[field]);
    if (endpoint.origin !== url.origin || !endpoint.pathname.startsWith(url.pathname.replace(/\/$/, '') + '/') || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
      throw new Error('OIDC endpoint origin mismatch.');
  }
  return {
    authorizationEndpoint: String(value.authorization_endpoint),
    tokenEndpoint: String(value.token_endpoint),
    jwksUri: String(value.jwks_uri),
  };
}
