const { execFileSync } = require('node:child_process');
const { rmSync, writeFileSync, readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { validate } = require('./validate.cjs');
const root = resolve(__dirname, '../..'), version = validate().version;
const candidate = beta => join(root, 'release-candidates', beta ? 'private-beta' : 'normal', `LionPocket${beta ? '-Beta' : ''}-Android-${version}-DEVELOPMENT-ONLY.apk`);
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const fixtures = process.env.LIONPOCKET_ANDROID_FIXTURES || '/tmp/lion-release-fixtures-ci';
const { currentSchemaVersion, versions } = JSON.parse(readFileSync(join(fixtures, 'metadata.json'), 'utf8'));
if (!Number.isSafeInteger(currentSchemaVersion) || currentSchemaVersion < 8 || !versions.includes(currentSchemaVersion))
  throw new Error('Current Mobile schema metadata required.');
const preparationReport = process.env.LIONPOCKET_ANDROID_PREPARATION_REPORT || '/tmp/lionpocket-android-preparation-secrets.json';
rmSync(preparationReport, { force: true });
execFileSync('python3', [join(__dirname, 'android-upgrade.py'), '--serial', serial, '--fixtures', fixtures, '--old-normal', join(root, 'release-candidates/base-normal.apk'), '--new-normal', candidate(false), '--old-beta', join(root, 'release-candidates/base-beta.apk'), '--new-beta', candidate(true), '--report', process.env.LIONPOCKET_ANDROID_UPGRADE_REPORT || '/tmp/android-upgrades.json'], { stdio: 'inherit' });
execFileSync('python3', [join(__dirname, 'android-compatibility.py'), '--serial', serial, '--expected-schema', String(currentSchemaVersion), '--mismatch-apk', process.env.LIONPOCKET_TEST_SIGNED_APK || '/tmp/LionPocket-EPHEMERAL-ONLY.apk', '--report', process.env.LIONPOCKET_ANDROID_COMPATIBILITY_REPORT || '/tmp/android-compatibility.json'], { stdio: 'inherit' });

// Instrumentation uses a disposable private subtree and random installation IDs, outside all financial fixtures.
execFileSync('adb', ['-s', serial, 'install', '-r', join(root, 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk')], { stdio: 'inherit' });
execFileSync('adb', ['-s', serial, 'install', '-r', join(root, 'apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')], { stdio: 'inherit' });
const nativeSecrets = execFileSync('adb', ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'com.lionpocketmobile.SyncSecretStorageTest', 'com.lionpocketmobile.test/androidx.test.runner.AndroidJUnitRunner'], { encoding: 'utf8', timeout: 120000 });
process.stdout.write(nativeSecrets);
if (!/OK \(4 tests\)/.test(nativeSecrets) || /FAILURES|INSTRUMENTATION_FAILED/.test(nativeSecrets)) throw new Error('Native preparation SecretStore regressions failed.');

const nativeBackup = execFileSync('adb', ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class', 'com.lionpocketmobile.DurableBackupFileTest', 'com.lionpocketmobile.test/androidx.test.runner.AndroidJUnitRunner'], { encoding: 'utf8', timeout: 120000 });
process.stdout.write(nativeBackup);
if (!/OK \(1 test\)/.test(nativeBackup) || /FAILURES|INSTRUMENTATION_FAILED/.test(nativeBackup)) throw new Error('Native activation checkpoint regressions failed.');
writeFileSync(preparationReport, JSON.stringify({ formatVersion: 1, tests: 4, passed: true, activationCheckpointPassed: true, backend: 'AndroidKeyStore/AndroidX AtomicFile', operationalV1Preserved: true, emulator: serial }));
