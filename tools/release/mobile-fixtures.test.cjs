const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('native fixtures preserve historical schema versions and cover the current nullable schedule', () => {
  const root = resolve(__dirname, '../..');
  const directory = mkdtempSync(join(tmpdir(), 'lion-release-fixtures-test-'));
  try {
    execFileSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(__dirname, 'mobile-fixtures.ts'), directory], { cwd: root, timeout: 10000, stdio: 'pipe' });
    const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.syntheticOnly, true);
    assert.ok(metadata.versions.includes(8));
    assert.ok(metadata.versions.includes(metadata.currentSchemaVersion));
    for (const version of metadata.versions) {
      const db = new DatabaseSync(join(directory, `v${version}.sqlite`), { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
        assert.equal(JSON.parse(readFileSync(join(directory, `v${version}.json`), 'utf8')).userVersion, version);
        if (version === metadata.currentSchemaVersion)
          assert.ok(db.prepare('SELECT count(*) AS n FROM recurring_expenses WHERE start_date IS NULL').get().n > 0);
        if (version === metadata.currentSchemaVersion)
          assert.deepEqual(db.prepare('SELECT month,safety_margin_cents FROM monthly_planning ORDER BY month').all().map(row => ({ ...row })), [{ month: '2026-10', safety_margin_cents: 50001 }, { month: '2026-11', safety_margin_cents: 30000 }]);
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
