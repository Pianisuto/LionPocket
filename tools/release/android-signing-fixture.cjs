// Ephemeral test identity outside the checkout, never a production credential.
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const directory = mkdtempSync(join(tmpdir(), 'lion-release-EPHEMERAL-signing-'));
const cwd = resolve(__dirname, '../../apps/mobile/android');
const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
const password = 'ephemeral-test-only';
const store = join(directory, 'EPHEMERAL-TEST-ONLY.p12');
try {
  execFileSync(keytool, ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-storepass', password, '-keypass', password, '-alias', 'ephemeral-test-only', '-dname', 'CN=LionPocket EPHEMERAL TEST ONLY', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2'], { stdio: 'ignore' });
  const cert = execFileSync(keytool, ['-exportcert', '-keystore', store, '-storepass', password, '-alias', 'ephemeral-test-only']);
  const fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  const file = join(directory, 'external-signing.properties');
  writeFileSync(file, `storeFile=${store.replaceAll('\\', '/')}
storePassword=${password}
keyAlias=ephemeral-test-only
keyPassword=${password}
certificateSha256=${fingerprint}
`, { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LIONPOCKET_ANDROID_')));
  env.LIONPOCKET_ANDROID_SIGNING_FILE = file;
  const run = args => spawnSync(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', args.concat(['--no-daemon', '--max-workers=2']), { cwd, env, encoding: 'utf8' });
  let result = run([':app:validateReleaseIdentity']);
  if (result.status !== 0) throw new Error('External ephemeral fixture signing failed.');
  console.log('PASS: external file and certificate pin accepted (EPHEMERAL TEST ONLY).');
  const original = require('node:fs').readFileSync(file, 'utf8');
  writeFileSync(file, original.replace(fingerprint, '0'.repeat(64)));
  result = run([':app:validateReleaseIdentity']);
  if (result.status === 0 || !(result.stdout + result.stderr).includes('could not be verified')) throw new Error('Wrong certificate pin was accepted.');
  console.log('PASS: mismatched signing certificate refused.');
  writeFileSync(file, original);
  if (process.argv.includes('--build')) {
    result = run([':app:assembleRelease', '-PreactNativeArchitectures=x86_64']);
    if (result.status !== 0) throw new Error('Ephemeral signed release packaging failed.');
    console.log(`PASS: release build with EPHEMERAL TEST ONLY certificate ${fingerprint}. APK must remain outside public artifacts.`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
