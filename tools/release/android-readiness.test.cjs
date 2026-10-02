const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

test('Android startup readiness waits for migration and diagnoses failures', () => {
  const run = spawnSync('python3', ['-m', 'unittest', '-v', 'test_android_readiness.py'], {
    cwd: __dirname, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
