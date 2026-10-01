// Execute the previous client implementation against the current real server.
const { mkdtempSync, symlinkSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const root = resolve(__dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'lion-release-previous-client-'));
const base = '8de0087cdbcdcc670ec2073ba3f4ea51932072b4';
try {
  const archive = execFileSync('git', ['archive', base, 'packages/sync-local'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  // Protocol source/dependencies are unchanged; all previous engine/controller code is compiled verbatim.
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'packages/sync-local/tsconfig.json')], { cwd: directory, stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'src/beta.integration.test.ts'], { cwd: join(root, 'apps/sync-server'), stdio: 'inherit', env: { ...process.env, LIONPOCKET_SYNC_INTEGRATION: '1', LIONPOCKET_PREVIOUS_CLIENT: join(directory, 'packages/sync-local/dist/beta.js') } });
  console.log(`PASS: previous engine/controller from ${base} interoperates with current PostgreSQL/Keycloak server.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
