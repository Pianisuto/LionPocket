// Runs only on the disposable native Windows CI runner. No network update/download.
const { existsSync, mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { captureDatabaseManifest } = require('../sync-stage0/database-manifest.cjs');
const { validate } = require('./validate.cjs');
if (process.platform !== 'win32' || process.env.CI !== 'true') throw new Error('Disposable Windows CI required.');
const root = resolve(__dirname, '../..'), beta = process.env.LIONPOCKET_BUILD_CHANNEL === 'private-beta';
const id = beta ? 'lionpocket_beta' : 'lionpocket';
const exe = beta ? 'lionpocket-beta.exe' : 'lionpocket.exe';
const install = join(process.env.LOCALAPPDATA, id);
const installer = join(root, 'apps/desktop/out/make/squirrel.windows/x64', beta ? 'LionPocket-Beta-Instalador.exe' : 'LionPocket-Instalador.exe');
const directory = mkdtempSync(join(realpathSync(tmpdir()), 'lion-release-smoke-'));
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', '$p=Start-Process -FilePath $env:LION_INSTALLER -ArgumentList "--silent" -PassThru -Wait; exit $p.ExitCode'], { env: { ...process.env, LION_INSTALLER: installer }, stdio: 'inherit', timeout: 120000 });
  const binary = join(install, `app-${validate().version}`, exe);
  if (!existsSync(binary) || !existsSync(join(install, 'Update.exe'))) throw new Error('Squirrel infrastructure missing or wrong channel identity.');
  // Stop only this installer-launched process; the runner contains no user database.
  execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:LION_INSTALLED_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { env: { ...process.env, LION_INSTALLED_EXE: binary }, stdio: 'inherit' });
  const profile = join(directory, beta ? 'LionPocket Beta' : 'LionPocket'); mkdirSync(profile);
  const db = new DatabaseSync(join(profile, 'lionpocket.sqlite'));
  db.exec(readFileSync(join(root, 'docs/fixtures/local-first/desktop-v10.sql'), 'utf8'));
  writeFileSync(join(directory, 'before.json'), JSON.stringify(captureDatabaseManifest(db))); db.close();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(binary, [`--release-smoke=${directory}`], { env, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw new Error(`Installed application failed: ${result.stderr}`);
  const report = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  if (report.beta !== beta || report.version !== validate().version) throw new Error('Installed channel/version mismatch.');
  if (beta ? report.updateFeed !== null : report.updateFeed !== `https://update.electronjs.org/Pianisuto/LionPocket/win32-x64/${validate().version}`) throw new Error('Squirrel update policy mismatch.');
  console.log(JSON.stringify({ ...report, squirrelInstalled: true, installerIdentity: id, updateFeedPolicy: beta ? 'disabled' : 'existing normal feed; smoke skips network checks' }));
} finally { rmSync(directory, { recursive: true, force: true }); }
