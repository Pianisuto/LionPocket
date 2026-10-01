const { execFileSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const { validate } = require('./validate.cjs');
const root = resolve(__dirname, '../..'), version = validate().version;
const candidate = beta => join(root, 'release-candidates', beta ? 'private-beta' : 'normal', `LionPocket${beta ? '-Beta' : ''}-Android-${version}-DEVELOPMENT-ONLY.apk`);
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
execFileSync('python3', [join(__dirname, 'android-upgrade.py'), '--serial', serial, '--fixtures', '/tmp/lion-release-fixtures-ci', '--old-normal', join(root, 'release-candidates/base-normal.apk'), '--new-normal', candidate(false), '--old-beta', join(root, 'release-candidates/base-beta.apk'), '--new-beta', candidate(true), '--report', '/tmp/android-upgrades.json'], { stdio: 'inherit' });
execFileSync('python3', [join(__dirname, 'android-compatibility.py'), '--serial', serial, '--mismatch-apk', '/tmp/LionPocket-EPHEMERAL-ONLY.apk', '--report', '/tmp/android-compatibility.json'], { stdio: 'inherit' });
