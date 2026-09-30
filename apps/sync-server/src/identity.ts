import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export interface Identity {
  issuer: string;
  subject: string;
}
export async function verifyAccessIdentity(
  token: string,
  issuer: string,
  keys: JWTVerifyGetKey,
): Promise<Identity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: 'lionpocket-sync-api',
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat'],
  });
  if (
    payload.typ !== 'Bearer' ||
    !['lionpocket-desktop-dev', 'lionpocket-android-dev'].includes(
      String(payload.azp),
    ) ||
    !payload.sub
  )
    throw new Error('unauthenticated');
  return { issuer, subject: payload.sub };
}
export function keycloakIdentity(issuer: string) {
  const keys = createRemoteJWKSet(
    new URL(`${issuer}/protocol/openid-connect/certs`),
  );
  return (token: string) => verifyAccessIdentity(token, issuer, keys);
}
