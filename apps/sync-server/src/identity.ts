import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export interface Identity {
  issuer: string;
  subject: string;
}
export async function verifyAccessIdentity(
  token: string,
  issuer: string,
  keys: JWTVerifyGetKey,
  clients = ["lionpocket-desktop", "lionpocket-android", "lionpocket-desktop-dev", "lionpocket-android-dev"],
): Promise<Identity> {
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: 'lionpocket-sync-api',
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat'],
  });
  if (
    payload.typ !== 'Bearer' ||
    !clients.includes(
      String(payload.azp),
    ) ||
    !payload.sub
  )
    throw new Error('unauthenticated');
  return { issuer, subject: payload.sub };
}
export function keycloakIdentity(issuer: string, clients?: string[]) {
  const keys = createRemoteJWKSet(
    new URL(`${issuer}/protocol/openid-connect/certs`),
  );
  return (token: string) => verifyAccessIdentity(token, issuer, keys, clients);
}
