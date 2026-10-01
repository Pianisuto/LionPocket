// Generates a disposable Android app. Never changes the financial app/package manifests.
const { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { tmpdir } = require('node:os');
const repo = resolve(__dirname, '../..');
const target = resolve(process.argv[2] || '');
const sdk = process.argv[3];
const peerReport = process.argv[4];
if (!process.argv[2] || !target.startsWith(resolve(tmpdir()) + '/') || !sdk)
  throw new Error('Usage: node prepare-native-harness.cjs /tmp/unique-spike-root /absolute/android-sdk');
if (existsSync(target) && realpathSync(target) !== target) throw new Error('Refusing a symlinked target.');
const manifest = join(target, 'package.json');
if (existsSync(target) && !existsSync(manifest) && readdirSync(target).length)
  throw new Error('Refusing a non-empty directory without a spike manifest.');
if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name !== 'lionpocket-native-crypto-spike')
  throw new Error('Refusing to overwrite a non-spike project.');
const app = join(target, 'apps/mobile');
mkdirSync(app, { recursive: true });
cpSync(join(repo, 'apps/mobile/android'), join(app, 'android'), { recursive: true,
  filter: (source) => !source.split('/').some((part) => ['.gradle', '.kotlin', '.cxx', 'build', 'local.properties'].includes(part)) });
const packageJson = JSON.parse(readFileSync(join(repo, 'apps/mobile/package.json'), 'utf8'));
packageJson.name = '@lionpocket/mobile-crypto-spike';
delete packageJson.dependencies['@lionpocket/core'];
packageJson.dependencies['react-native-libsodium'] = '1.7.0';
writeFileSync(join(app, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
writeFileSync(manifest, JSON.stringify({ name: 'lionpocket-native-crypto-spike', private: true, workspaces: ['apps/mobile','packages/*'] }, null, 2) + '\n');
for (const name of ['core','sync-protocol','sync-local']) {
  const destination = join(target,'packages',name); mkdirSync(destination,{recursive:true});
  const pkg = JSON.parse(readFileSync(join(repo,'packages',name,'package.json'),'utf8')); delete pkg.devDependencies;
  writeFileSync(join(destination,'package.json'),JSON.stringify(pkg,null,2));
  cpSync(join(repo,'packages',name,'dist'),join(destination,'dist'),{recursive:true});
}
for (const name of ['babel.config.js', 'metro.config.js']) cpSync(join(repo, 'apps/mobile', name), join(app, name));
const gradle = join(app, 'android/app/build.gradle');
writeFileSync(gradle, readFileSync(gradle, 'utf8').replace('react {', 'react {\n    debuggableVariants = [] // Offline spike: bundle JS even in debug.').replace(/applicationId (?:privateBeta \? "com.lionpocketmobile.beta" : )?"com.lionpocketmobile"/, 'applicationId "com.lionpocketmobile.cryptospike"'));
mkdirSync(join(target, 'tools/release'), { recursive: true });
cpSync(join(repo, 'tools/release/version.json'), join(target, 'tools/release/version.json'));
require('node:fs').appendFileSync(join(app, 'android/gradle.properties'), '\n# Disposable test harness only; never a production identity.\ndevelopmentSigning=true\n');
writeFileSync(join(app, 'android/local.properties'), 'sdk.dir=' + resolve(sdk) + '\n');
cpSync(join(__dirname, 'native-harness/index.js'), join(app, 'index.js'));
cpSync(join(__dirname, 'crypto-checks.cjs'), join(app, 'crypto-checks.cjs'));
cpSync(join(repo, 'packages/sync-protocol/fixtures'), join(app, 'fixtures'), { recursive: true });
writeFileSync(join(app, 'fixtures/peer.json'), peerReport ? readFileSync(resolve(peerReport)) : JSON.stringify({ sealedBox: JSON.parse(readFileSync(join(app, 'fixtures/crypto.json'), 'utf8')).sealedBox }));
mkdirSync(join(app, 'protocol'), { recursive: true });
for (const name of ['canonical.js', 'envelope.js', 'control.js']) cpSync(join(repo, 'packages/sync-protocol/dist', name), join(app, 'protocol', name));
const java = join(app, 'android/app/src/main/java/com/lionpocketmobile');
cpSync(join(__dirname, 'native-harness/CryptoSpikeReportModule.kt'), join(java, 'CryptoSpikeReportModule.kt'));
cpSync(join(repo,'apps/mobile/android/app/src/main/java/com/lionpocketmobile/SyncIdentityModule.kt'),join(java,'SyncIdentityModule.kt'));
const application = join(java, 'MainApplication.kt');
writeFileSync(application, readFileSync(application, 'utf8').replace('context = applicationContext,', 'context = applicationContext,\n      useDevSupport = false,').replace('add(LocalFilesPackage())', 'add(CryptoSpikeReportPackage())\n          add(LocalFilesPackage())'));

// Copy the actual mobile migration source unchanged; only resolve its pure core catalog import.
for (const name of ['migrations.ts', 'catalogDefaults.ts']) cpSync(join(repo, 'apps/mobile/src/db', name), join(app, name));
const catalogs = join(app, 'catalogDefaults.ts');
writeFileSync(catalogs, readFileSync(catalogs, 'utf8').replace("'@lionpocket/core'", "'./core-catalog-defaults'"));
cpSync(join(repo, 'packages/core/src/catalog-defaults.ts'), join(app, 'core-catalog-defaults.ts'));
cpSync(join(__dirname, 'native-harness/storage-checks.js'), join(app, 'storage-checks.js'));
// A restricted lexer for the trusted committed SQL fixtures, not an import parser.
function splitStatements(sql) {
  let quote = '', statement = '', statements = [];
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]; statement += char;
    if (quote && char === quote) {
      if (sql[i + 1] === quote) statement += sql[++i];
      else quote = '';
    } else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (!quote && char === ';') { statements.push(statement); statement = ''; }
  }
  if (quote || statement.trim()) throw new Error('Incomplete trusted fixture SQL.');
  return statements;
}
const databases = [1, 2, 3, 4].map((version) => {
  const sql = readFileSync(join(repo, `docs/fixtures/local-first/mobile-v${version}.sql`), 'utf8').replace(/^--[^\n]*$/gm, '');
  const db = new DatabaseSync(':memory:');
  try {
    const statements = splitStatements(sql);
    for (const statement of statements) db.exec(statement);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error('Unexpected fixture table.');
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
      const rows = db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all().map((row) => columns.map((column) => row[column]))
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      return { name, columns, rows };
    });
    return { version, statements, tables };
  } finally { db.close(); }
});
writeFileSync(join(app, 'fixtures/databases.json'), JSON.stringify(databases));

console.log(JSON.stringify({ target, applicationId: 'com.lionpocketmobile.cryptospike', binding: 'react-native-libsodium@1.7.0' }));
