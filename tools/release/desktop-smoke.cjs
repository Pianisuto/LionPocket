const { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { captureDatabaseManifest } = require('../sync-stage0/database-manifest.cjs');
const root = resolve(__dirname, '../..');
const beta = process.env.LIONPOCKET_BUILD_CHANNEL === 'private-beta';
const name = beta ? 'LionPocket-Beta' : 'LionPocket';
const executable = process.platform === 'win32' ? `${beta ? 'lionpocket-beta' : 'lionpocket'}.exe` : beta ? 'lionpocket-beta' : 'lionpocket';
const binary = join(root, 'apps/desktop/out', `${name}-${process.platform}-x64`, executable);
for (const mode of beta ? [true] : [false, true]) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'lion-release-smoke-'));
  try {
    const profile = join(directory, mode ? 'LionPocket Beta' : 'LionPocket');
    mkdirSync(profile);
    const db = new DatabaseSync(join(profile, 'lionpocket.sqlite'));
    db.exec(readFileSync(join(root, 'docs/fixtures/local-first/desktop-v10.sql'), 'utf8'));
    writeFileSync(join(directory, 'before.json'), JSON.stringify(captureDatabaseManifest(db)));
    db.close();
    const args = [`--release-smoke=${directory}`, ...(mode && !beta ? ['--private-beta'] : []), ...(process.platform === 'linux' ? ['--password-store=basic'] : [])];
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 90000 });
    if (result.status !== 0) throw new Error(`Packaged app failed (${result.status}): ${result.stderr}`);
    const report = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    if (report.beta !== mode || report.version !== require('./validate.cjs').validate().version) throw new Error('Channel/version mismatch.');
    console.log(JSON.stringify(report));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
