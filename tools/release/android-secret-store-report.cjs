// A green emulator wrapper alone is insufficient: require the completed native suite's report.
const { readFileSync } = require('node:fs');
const report = JSON.parse(readFileSync('/tmp/lionpocket-android-preparation-secrets.json', 'utf8'));
if (report.formatVersion !== 1 || report.tests !== 4 || report.passed !== true || report.operationalV1Preserved !== true ||
    report.backend !== 'AndroidKeyStore/AndroidX AtomicFile' || !/^emulator-[0-9]+$/.test(report.emulator))
  throw new Error('Native preparation SecretStore evidence is missing or invalid.');
console.log('ANDROID_PREPARATION_SECRETSTORE_PASS ' + JSON.stringify(report));
