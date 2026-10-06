/** Installed Android entry point. Synthetic keys only; no QR/capability is written to stdout. */
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const sodium = require('libsodium-wrappers-sumo');
const {
  DeviceProvisioning,
  ProvisioningCrypto,
  secretContext,
} = require('@lionpocket/sync-local');
const {
  inviteSigningInput,
  pairingLink,
} = require('@lionpocket/sync-protocol');
const root = resolve(__dirname, '../..'),
  serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const packageName = 'com.lionpocketmobile';
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  if (
    !serial.startsWith('emulator-') ||
    adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1'
  )
    throw new Error('Disposable emulator required');
  const version = JSON.parse(
    readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'),
  ).version;
  const candidate =
    process.env.LIONPOCKET_PAIRING_APK ||
    join(
      root,
      'release-candidates/normal',
      `LionPocket-Android-${version}-DEVELOPMENT-ONLY.apk`,
    );
  if (existsSync(candidate)) adb('install', '-r', candidate);
  await sodium.ready;
  const crypto = new ProvisioningCrypto(sodium),
    values = new Map();
  const secrets = {
    load: async (scope) => values.get(secretContext(scope))?.slice() || null,
    store: async (scope, value) => {
      values.set(secretContext(scope), value.slice());
    },
    remove: async (scope) => {
      values.delete(secretContext(scope));
    },
  };
  const d = await DeviceProvisioning.prepare(
    {
      serverId: crypto.uuid(),
      serverEpoch: crypto.uuid(),
      vaultId: crypto.uuid(),
      founderDeviceId: crypto.uuid(),
      authorityPublicKey: crypto.nonce(),
      keyVersion: 1,
    },
    secrets,
    crypto,
    true,
  );
  const seed = sodium.randombytes_buf(32),
    keys = sodium.crypto_sign_seed_keypair(seed),
    authority = await secrets.load(d.scope('authoritySeed'));
  const invite = {
    version: 2,
    purpose: 'device-pairing',
    id: crypto.uuid(),
    endpoint: 'https://sync.pairing-fixture.invalid',
    pin: d.profile.pin,
    expiresAt: Date.now() + 900000,
    capabilityHash: crypto.hash(crypto.encode(seed)),
    capabilityPublicKey: crypto.encode(keys.publicKey),
  };
  const capability = crypto.encode(seed),
    link = pairingLink(
      {
        invite: {
          ...invite,
          signature: crypto.sign(inviteSigningInput(invite), authority),
        },
        capability,
      },
      crypto,
    );
  crypto.erase(seed);
  crypto.erase(keys.privateKey);
  crypto.erase(authority);
  const originalUser = adb('shell', 'am', 'get-current-user').trim();
  const user = /id (\d+)/.exec(
    adb('shell', 'pm', 'create-user', 'LionPocket pairing fixture'),
  )?.[1];
  if (!user) throw new Error('Isolated user unavailable');
  try {
    adb('shell', 'pm', 'install-existing', '--user', user, packageName);
    adb('shell', 'am', 'start-user', '-w', user);
    adb('shell', 'am', 'switch-user', user);
    await wait(2000);
    adb('shell', 'input', 'keyevent', '82');
    // Captured output can contain the URI; never print it or an exec error with its arguments.
    adb(
      'shell',
      'am',
      'start',
      '--user',
      user,
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      link,
      packageName,
    );
    let xml = '';
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      try {
        adb('shell', 'uiautomator', 'dump', '/sdcard/lp-pairing-smoke.xml');
        xml = adb('shell', 'cat', '/sdcard/lp-pairing-smoke.xml');
        if (
          xml.includes('sync.pairing-fixture.invalid') &&
          xml.includes('Conectar ao cofre pessoal')
        )
          break;
      } catch {
        /* Boot/first render may still be in progress. */
      }
      await wait(250);
    }
    if (
      !xml.includes('sync.pairing-fixture.invalid') ||
      (xml.match(/text="Conectar"/g) || []).length !== 1 ||
      /Servidor próprio|Conferir convite|Código de segurança do cofre conferido/.test(
        xml,
      )
    )
      throw new Error('Deep link did not open the direct confirmation');
    const logs = adb(
      'logcat',
      '-d',
      'ReactNativeJS:V',
      'LionPocketPairing:V',
      'LionPocketSecrets:V',
      '*:S',
    );
    if (
      logs.includes(capability) ||
      logs.includes(link) ||
      logs.includes(link.slice('lionpocket://pair/'.length))
    )
      throw new Error('Secret leaked in app logs');
    writeFileSync(
      '/tmp/lionpocket-pairing-native.json',
      JSON.stringify({
        passed: true,
        deepLink: true,
        endpointFromInvite: true,
        confirmationButtons: 1,
        secretLogs: false,
        syntheticOnly: true,
      }),
    );
    console.log(
      'Android installed deep link: direct Conectar, endpoint from LPV2, no secret in app logs.',
    );
  } finally {
    adb('shell', 'am', 'switch-user', originalUser);
    await wait(1000);
    adb('shell', 'am', 'stop-user', '-w', '-f', user);
    adb('shell', 'pm', 'remove-user', user);
  }
}
main().catch(() => {
  console.error(
    'Android pairing smoke failed (invitation and command arguments redacted).',
  );
  process.exitCode = 1;
});
