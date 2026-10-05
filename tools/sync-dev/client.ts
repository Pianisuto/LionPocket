import { app, shell } from 'electron';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  DeviceProvisioning,
  ProvisioningCrypto,
  type ProvisionedProfile,
  type RegistryResponse,
} from '@lionpocket/sync-local';
import {
  assertTrustPin,
  canonicalStringify,
  decodeCanonical,
  type PairingRequest,
  type TrustPin,
} from '@lionpocket/sync-protocol';
import { desktopCrypto } from '../../apps/desktop/src/main/sync/crypto';
import { DesktopSecretStore } from '../../apps/desktop/src/main/sync/secretStore';
import {
  loginDevelopmentOidc,
  type DevClientId,
} from '../../apps/desktop/src/main/sync/oidc';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    invitation: { type: 'string' },
    request: { type: 'string' },
    fingerprint: { type: 'string' },
    client: { type: 'string', default: 'lionpocket-desktop-dev' },
  },
});
const command = positionals[0];
if (
  !values.profile ||
  ![
    'create',
    'pair',
    'approve',
    'receive',
    'registry',
    'revoke',
    'deliver',
  ].includes(command)
)
  throw new Error(
    'Use create|pair|approve|receive|registry|revoke|deliver --profile /tmp/lion-sync-dev-NAME [--invitation PATH --request PATH --fingerprint VALUE]',
  );
const directory = resolve(values.profile);
// Never open a personal profile or LionPocket financial database.
if (!directory.startsWith('/tmp/lion-sync-dev-'))
  throw new Error('Synthetic profile must be under /tmp/lion-sync-dev-NAME.');
app.setPath('userData', join(directory, 'electron'));
const origin = 'http://127.0.0.1:8787';
app
  .whenReady()
  .then(async () => {
    const crypto = new ProvisioningCrypto(await desktopCrypto());
    const secrets = new DesktopSecretStore(join(directory, 'secret-wrappers'));
    const publicRead = async (path: string) =>
      decodeCanonical(new Uint8Array(await readFile(path)), 4194304);
    const publicWrite = async (path: string, value: unknown) => {
      const temp = path + '.' + randomUUID();
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(canonicalStringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const profilePath = join(directory, 'public-profile.json');
    let saved:
      | {
          synthetic: true;
          identity: { issuer: string; subject: string };
          profile: ProvisionedProfile;
        }
      | undefined;
    try {
      saved = (await publicRead(profilePath)) as typeof saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved && saved.synthetic !== true)
      throw new Error('Synthetic profile required.');
    if (['create', 'pair'].includes(command) && saved?.profile.checkpoint)
      throw new Error(
        'Profile already provisioned; use registry or another synthetic directory.',
      );
    const session = await loginDevelopmentOidc(
      values.client as DevClientId,
      async (url) => {
        console.log(
          'Abrindo login no browser do sistema. Conta sintética: alice / synthetic-only-alice.',
        );
        await shell.openExternal(url);
      },
    );
    if (
      saved &&
      (saved.identity.issuer !== session.issuer ||
        saved.identity.subject !== session.subject)
    )
      throw new Error('Profile identity mismatch.');
    let client: DeviceProvisioning;
    if (saved) {
      client = new DeviceProvisioning(saved.profile, secrets, crypto);
    } else if (command === 'create') {
      const envResponse = await fetch(`${origin}/v1/environment`);
      const env = (await envResponse.json()) as {
        serverId: string;
        serverEpoch: string;
      };
      const pin: TrustPin = {
        ...env,
        vaultId: crypto.uuid(),
        founderDeviceId: crypto.uuid(),
        authorityPublicKey: crypto.nonce(),
        keyVersion: 1,
      };
      // Keep only the declared scope; capabilities from the public environment are not pin fields.
      const cleanPin = {
        serverId: pin.serverId,
        serverEpoch: pin.serverEpoch,
        vaultId: pin.vaultId,
        founderDeviceId: pin.founderDeviceId,
        authorityPublicKey: pin.authorityPublicKey,
        keyVersion: 1,
      };
      client = await DeviceProvisioning.prepare(
        cleanPin,
        secrets,
        crypto,
        true,
      );
    } else if (command === 'pair') {
      if (!values.invitation || !values.fingerprint)
        throw new Error(
          'Pair requires a trusted invitation and its fingerprint.',
        );
      const pin = await publicRead(values.invitation);
      assertTrustPin(pin);
      if (
        crypto.hash(
          canonicalStringify({ context: 'LionPocket/trust-pin/v1', pin }),
        ) !== values.fingerprint
      )
        throw new Error('Invitation fingerprint mismatch.');
      client = await DeviceProvisioning.prepare(pin, secrets, crypto);
    } else {
      throw new Error('No provisioned synthetic profile.');
    }
    const save = async () =>
      publicWrite(profilePath, {
        synthetic: true,
        identity: { issuer: session.issuer, subject: session.subject },
        profile: client.profile,
      });
    // Seeds are wrapped already; save public IDs before the first network mutation so a retry never regenerates them.
    await save();
    const base = `/v1/vaults/${client.profile.pin.vaultId}`;
    const request = async (
      method: string,
      path: string,
      value?: unknown,
    ): Promise<RegistryResponse> => {
      const body = value === undefined ? '' : canonicalStringify(value);
      const proof = await client.proof(
        method,
        path,
        origin,
        body,
        session.accessToken,
      );
      const response = await fetch(origin + path, {
        method,
        signal: AbortSignal.timeout(15000),
        headers: {
          'x-lionpocket-control-version': '2',
          authorization: 'Bearer ' + session.accessToken,
          'content-type': 'application/json',
          'x-lionpocket-proof': Buffer.from(canonicalStringify(proof)).toString(
            'base64url',
          ),
        },
        body: body || undefined,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const result = decodeCanonical(bytes, 4194304) as RegistryResponse;
      if (!response.ok)
        throw new Error(`Control API rejected: ${canonicalStringify(result)}`);
      return result;
    };
    if (command === 'create') {
      const pairing = await client.request(),
        grant = await client.grant(pairing, pairing.fingerprint);
      try {
        client.acceptRegistry(
          await request('POST', '/v1/vaults', {
            pin: client.profile.pin,
            grant,
            request: pairing,
          }),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('vault_exists')
        )
          throw error;
        client.acceptRegistry(await request('GET', base + '/registry'));
      }
      await publicWrite(join(directory, 'invitation.json'), client.profile.pin);
      console.log('Invitation:', join(directory, 'invitation.json'));
      console.log(
        'Trust fingerprint:',
        crypto.hash(
          canonicalStringify({
            context: 'LionPocket/trust-pin/v1',
            pin: client.profile.pin,
          }),
        ),
      );
    }
    if (command === 'pair') {
      let pairing: PairingRequest;
      try {
        pairing = (await publicRead(
          join(directory, 'pairing-request.json'),
        )) as PairingRequest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        pairing = await client.request();
      }
      await publicWrite(join(directory, 'pairing-request.json'), pairing);
      await request('POST', base + '/pairings', pairing);
      console.log('Request:', join(directory, 'pairing-request.json'));
      console.log('Pairing fingerprint:', pairing.fingerprint);
    }
    if (command === 'approve' || command === 'revoke') {
      if (!values.request || !values.fingerprint)
        throw new Error('Explicit request and compared fingerprint required.');
      client.acceptRegistry(await request('GET', base + '/registry'));
      const pairing = (await publicRead(values.request)) as PairingRequest;
      const grant = await client.grant(
        pairing,
        values.fingerprint,
        command === 'revoke' ? 'revoked' : 'approved',
      );
      client.acceptRegistry(await request('POST', base + '/grants', grant));
      await save();
      if (command === 'approve')
        await request(
          'POST',
          base + '/deliveries',
          await client.delivery(pairing.deviceId),
        );
    }
    if (command === 'deliver') {
      if (!values.request)
        throw new Error('Delivery retry requires the public pairing request.');
      client.acceptRegistry(await request('GET', base + '/registry'));
      const pairing = (await publicRead(values.request)) as PairingRequest;
      await request(
        'POST',
        base + '/deliveries',
        await client.delivery(pairing.deviceId),
      );
    }
    if (command === 'receive')
      await client.receive(await request('GET', base + '/registry'));
    if (command === 'registry') {
      client.acceptRegistry(await request('GET', base + '/registry'));
      console.log('Registry version:', client.profile.checkpoint?.version);
    }
    await save();
    console.log('Concluído:', command, '| lançamentos desativados.');
  })
  .then(() => app.quit())
  .catch(() => {
    console.error(
      'Falha no provisioning/login/trust/cofre; sem fallback. Consulte os dados públicos do perfil sintético.',
    );
    app.exit(1);
  });
