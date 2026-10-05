const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { writePublicMetadata } = require('./publication-metadata.cjs');
const { validate } = require('./validate.cjs');

test('public manifest uses the release Android code and all assets, including the manifest, verify', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lion-public-metadata-'));
  try {
    const version = validate(), source = 'a'.repeat(40);
    writeFileSync(join(directory, `LionPocket-Android-${version.version}.apk`), 'synthetic APK bytes');
    writeFileSync(join(directory, 'LionPocket-Instalador.exe'), 'synthetic Windows bytes');
    writePublicMetadata(directory, source, `v${version.version}`);
    const manifest = JSON.parse(readFileSync(join(directory, 'build-manifest.json'), 'utf8'));
    assert.equal(manifest.androidVersionCode, version.androidVersionCode);
    assert.equal(manifest.version, version.version);
    assert.equal(manifest.source, source);
    assert.equal(manifest.publicRelease, true);
    const sums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    assert.equal(sums.length, 3);
    assert.ok(sums.some(line => line.endsWith('  build-manifest.json')));
    for (const line of sums) {
      const [digest, file] = line.split('  ');
      assert.equal(digest, createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('wrong release tag or missing source refuses publication metadata without changing artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lion-public-metadata-'));
  try {
    writeFileSync(join(directory, 'preserved.apk'), 'original bytes');
    assert.throws(() => writePublicMetadata(directory, 'a'.repeat(40), 'v0.0.0'), /Tag/);
    assert.throws(() => writePublicMetadata(directory, undefined, `v${validate().version}`), /source/);
    assert.deepEqual(readdirSync(directory), ['preserved.apk']);
    assert.equal(readFileSync(join(directory, 'preserved.apk'), 'utf8'), 'original bytes');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
