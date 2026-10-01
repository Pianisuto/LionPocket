import { discoverOidc } from '@lionpocket/sync-local';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const devOidc = {
  issuer: 'http://127.0.0.1:18080/realms/lionpocket-dev',
  clients: {
    'lionpocket-desktop-dev': 'http://127.0.0.1:18761/callback',
    'lionpocket-android-dev': 'http://127.0.0.1:18762/callback',
  },
} as const;
export type DevClientId = keyof typeof devOidc.clients;
/** Shared system-browser flow. Only the legacy synthetic wrapper enables loopback HTTP. */
async function authenticateOidc(
  config: { issuer: string; clientId: string; redirectUri: string },
  openExternal: (url: string) => Promise<void>,
  timeoutMs: number,
  development = false,
) {
  const { issuer, clientId: loginClientId, redirectUri } = config;
  if (!development && redirectUri !== 'http://127.0.0.1:18761/callback') throw new Error('Invalid desktop callback.');
  const discovery = await discoverOidc(issuer, development);
  const verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url');
  const keys = createRemoteJWKSet(
    new URL(discovery.jwksUri),
  );
  const auth = new URL(discovery.authorizationEndpoint);
  auth.search = new URLSearchParams({
    client_id: loginClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    nonce,
    prompt: 'login',
  }).toString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callback = createServer();
  try {
    const codePromise = new Promise<string>((resolve, reject) => {
      callback.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        const states = url.searchParams.getAll('state'),
          codes = url.searchParams.getAll('code');
        if (
          req.method !== 'GET' ||
          url.pathname !== '/callback' ||
          states.length !== 1 ||
          states[0] !== state ||
          codes.length !== 1 ||
          !codes[0] ||
          url.searchParams.has('error') ||
          (url.searchParams.has('iss') &&
            url.searchParams.get('iss') !== issuer)
        ) {
          res.writeHead(400, { 'cache-control': 'no-store' });
          res.end('Invalid login callback.');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end('Login concluído. Volte ao aplicativo LionPocket.');
        resolve(codes[0]);
      });
      callback.once('error', reject);
      timer = setTimeout(
        () => reject(new Error('Login timed out.')),
        timeoutMs,
      );
    });
    await new Promise<void>((resolve, reject) => {
      callback.once('error', reject);
      callback.listen(Number(new URL(redirectUri).port), '127.0.0.1', resolve);
    });
    // Hook is shell.openExternal in the Electron runner; test hook drives only the synthetic IdP form.
    await openExternal(auth.toString());
    const code = await codePromise;
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: loginClientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw new Error('OIDC code exchange rejected.');
    const text = await response.text();
    if (text.length > 65536) throw new Error('Invalid OIDC response.');
    const tokens = JSON.parse(text) as {
      id_token?: string;
      access_token?: string;
      token_type?: string;
    };
    if (
      tokens.token_type !== 'Bearer' ||
      !tokens.id_token ||
      !tokens.access_token
    )
      throw new Error('Invalid OIDC response.');
    const id = await jwtVerify(tokens.id_token, keys, {
      issuer,
      audience: loginClientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
    const access = await jwtVerify(tokens.access_token, keys, {
      issuer,
      audience: 'lionpocket-sync-api',
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (
      id.payload.nonce !== nonce ||
      id.payload.sub !== access.payload.sub ||
      access.payload.azp !== loginClientId ||
      access.payload.typ !== 'Bearer' ||
      (id.payload.azp && id.payload.azp !== loginClientId)
    )
      throw new Error('OIDC identity mismatch.');
    return {
      accessToken: tokens.access_token,
      issuer,
      subject: access.payload.sub as string,
      expiresAt: access.payload.exp! * 1000,
    };
  } finally {
    clearTimeout(timer);
    callback.closeAllConnections();
    await new Promise<void>((resolve) => callback.close(() => resolve()));
  }
}

/** Normal and beta use discovered public clients; no development client ID is required. */
export function loginOidc(config: { issuer: string; clientId: string; redirectUri: string }, open: (url: string) => Promise<void>) {
  return authenticateOidc(config, open, 180000);
}
/** Compatibility entry point restricted to the isolated synthetic deployment. */
export async function loginDevelopmentOidc(
  clientId: DevClientId, openExternal: (url: string) => Promise<void>, timeoutMs = 180000,
) {
  if (!Object.hasOwn(devOidc.clients, clientId)) throw new Error('Unsupported development client.');
  return authenticateOidc({ issuer: devOidc.issuer, clientId, redirectUri: devOidc.clients[clientId] }, openExternal, timeoutMs, true);
}
