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
cpSync(join(repo,'apps/mobile/src'),join(app,'src'),{recursive:true,filter:(source)=>!source.endsWith('.test.ts')});
cpSync(join(__dirname,'android-index.js'),join(app,'index.js'));
cpSync(join(__dirname,'manual-checks.cjs'),join(app,'manual-checks.cjs'));
const java = join(app,'android/app/src/main/java/com/lionpocketmobile');
cpSync(join(__dirname,'SecretStoreProbeModule.kt'),join(java,'SecretStoreProbeModule.kt'));
const application = join(java,'MainApplication.kt');
writeFileSync(application,readFileSync(application,'utf8').replace('add(SyncSecretsPackage())','add(SyncSecretsPackage())\n          add(SecretStoreProbePackage())'));
