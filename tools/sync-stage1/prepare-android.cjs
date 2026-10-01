const { execFileSync } = require('node:child_process');
const { cpSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const repo = resolve(__dirname, '../..');
const target = resolve(process.argv[2] || '');
// Reuse the guarded isolated template/fixtures from Stage 0, with actual app sources.
execFileSync(process.execPath, [join(repo, 'tools/sync-stage0/prepare-native-harness.cjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
const app = join(target, 'apps/mobile');
const pkg = JSON.parse(readFileSync(join(app,'package.json'))); pkg.dependencies['@lionpocket/core']='0.1.0';
writeFileSync(join(app,'package.json'),JSON.stringify(pkg,null,2));
cpSync(join(repo,'apps/mobile/App.tsx'),join(app,'App.tsx'));
cpSync(join(repo,'apps/mobile/src'),join(app,'src'),{recursive:true,filter:(source)=>!source.endsWith('.test.ts')});
cpSync(join(__dirname,'android-index.js'),join(app,'index.js'));
cpSync(join(__dirname,'manual-checks.cjs'),join(app,'manual-checks.cjs'));
const java = join(app,'android/app/src/main/java/com/lionpocketmobile');
cpSync(join(__dirname,'SecretStoreProbeModule.kt'),join(java,'SecretStoreProbeModule.kt'));
const application = join(java,'MainApplication.kt');
writeFileSync(application,readFileSync(application,'utf8').replace('add(SyncSecretsPackage())','add(SyncSecretsPackage())\n          add(SecretStoreProbePackage())'));

cpSync(join(repo,'tools/sync-dev/native-checks.cjs'),join(app,'provisioning-checks.cjs'));

// Only the synthetic application may use loopback HTTP in debug/release.
const manifestPath=join(app,'android/app/src/main/AndroidManifest.xml');
writeFileSync(manifestPath,readFileSync(manifestPath,'utf8').replace(/android:networkSecurityConfig="[^"]*"\s*/g,'').replace('<application','<uses-permission android:name="android.permission.INTERNET" />\n    <application').replace('android:usesCleartextTraffic="${usesCleartextTraffic}"','android:networkSecurityConfig="@xml/sync_dev_network_security"'));
require('node:fs').mkdirSync(join(app,'android/app/src/main/res/xml'),{recursive:true});
writeFileSync(join(app,'android/app/src/main/res/xml/sync_dev_network_security.xml'),'<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config></network-security-config>');
