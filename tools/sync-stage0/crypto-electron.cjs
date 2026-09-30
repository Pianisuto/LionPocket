// Run with the development Electron binary; never the installed financial app.
const { app, safeStorage } = require('electron');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { runCryptoChecks } = require('./crypto-checks.cjs');
if (!process.argv[2]) throw new Error('Pass isolated npm directory.');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'lion-crypto-electron-')));
app.whenReady().then(async () => {
  const sodium = createRequire(resolve(process.argv[2], 'package.json'))('libsodium-wrappers-sumo');
  const fixture = (name) => JSON.parse(readFileSync(resolve(__dirname, '../../packages/sync-protocol/fixtures/' + name + '.json'), 'utf8'));
  const result = await runCryptoChecks(sodium, fixture('crypto'), fixture('serialization'), require('../../packages/sync-protocol/dist'), (bytes) => createHash('sha256').update(bytes).digest('hex'), fixture('control'), process.argv[4] ? JSON.parse(readFileSync(process.argv[4], 'utf8')) : undefined);
  const report = { ...result, runtime: 'Electron main', electron: process.versions.electron, node: process.versions.node, libsodium: sodium.sodium_version_string(), secretStorage: { available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend(), persistenceAllowed: safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text' } };
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
