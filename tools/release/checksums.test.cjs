const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validate } = require('./validate.cjs');
const tool = join(__dirname, 'checksums.cjs');
test('checksums verify candidate bytes and refuse missing or stale version artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lion-release-checksums-'));
  try {
    const name = `LionPocket-${validate().version}.zip`, bytes = Buffer.from('synthetic candidate bytes');
    writeFileSync(join(directory, name), bytes);
    const run = extension => spawnSync(process.execPath, [tool, directory, extension], { encoding: 'utf8' });
    assert.equal(run('.zip').status, 0);
    assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    assert.equal(JSON.parse(readFileSync(join(directory, 'build-manifest.json'), 'utf8')).version, validate().version);
    assert.notEqual(run('.apk').status, 0);
    writeFileSync(join(directory, 'LionPocket-stale-0.0.0.zip'), bytes);
    assert.notEqual(run('.zip').status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
