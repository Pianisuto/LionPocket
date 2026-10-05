const { readFileSync, mkdirSync, copyFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { validate } = require('./validate.cjs');

const root = resolve(__dirname, '../..');
const output = join(root, 'apps/mobile/android/app/build/outputs/apk/release');
const metadata = JSON.parse(readFileSync(join(output, 'output-metadata.json'), 'utf8'));
const version = validate();
if (metadata.applicationId !== 'com.lionpocketmobile' || metadata.elements.length !== 1 ||
    metadata.elements[0].versionName !== version.version ||
    metadata.elements[0].versionCode !== version.androidVersionCode)
  throw new Error('Android production candidate identity/version mismatch.');

const apk = join(output, metadata.elements[0].outputFile);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('ANDROID_HOME required.');
const expected = String(process.env.LIONPOCKET_ANDROID_CERTIFICATE_SHA256 || '').toLowerCase().replaceAll(':', '');
if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('Production certificate SHA-256 required.');
if (expected === 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c')
  throw new Error('Development certificate cannot be published.');

const signer = join(sdk, 'build-tools/37.0.0/apksigner');
const report = execFileSync(signer, ['verify', '--print-certs', apk], { encoding: 'utf8' });
const match = report.match(/certificate SHA-256 digest:\s*([0-9a-f:]+)/i);
const actual = match?.[1]?.toLowerCase().replaceAll(':', '');
if (actual !== expected) throw new Error('Production APK certificate mismatch.');

const directory = join(root, 'release-candidates', 'public');
mkdirSync(directory, { recursive: true });
const target = join(directory, `LionPocket-Android-${version.version}.apk`);
copyFileSync(apk, target);
console.log(JSON.stringify({
  package: metadata.applicationId,
  ...version,
  candidate: target,
  certificateSha256: actual,
  signing: 'production external identity',
}));
