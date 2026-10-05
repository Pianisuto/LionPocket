const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { validate } = require('./validate.cjs');

function writePublicMetadata(directory, source, tag) {
  const version = validate(tag);
  if (!/^[0-9a-f]{40}$/.test(source || '')) throw new Error('Release source commit required.');
  writeFileSync(join(directory, 'build-manifest.json'), JSON.stringify({
    ...version, source, tag: `v${version.version}`, publicRelease: true,
    server: 'Git tag/source archive is the self-hosted server release',
  }, null, 2) + '\n');
  // Include the manifest itself: users can verify the version/source declaration
  // together with every downloaded artifact using the published checksums.
  const sums = readdirSync(directory).filter(name => name !== 'SHA256SUMS.txt').sort()
    .map(name => `${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}  ${name}`)
    .join('\n') + '\n';
  writeFileSync(join(directory, 'SHA256SUMS.txt'), sums);
}
module.exports = { writePublicMetadata };
if (require.main === module) writePublicMetadata(resolve(process.argv[2] || 'release-assets'), process.env.GITHUB_SHA, `v${process.env.RELEASE_VERSION}`);
