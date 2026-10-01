const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const release = read('tools/release/version.json');
function validate(tag) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !Number.isSafeInteger(release.androidVersionCode) || release.androidVersionCode < 3)
    throw new Error('Invalid release version or Android versionCode.');
  if (read('apps/desktop/package.json').version !== release.version || read('package-lock.json').packages['apps/desktop'].version !== release.version)
    throw new Error('Desktop, lockfile and release versions must agree.');
  if (tag && tag !== `v${release.version}`) throw new Error('Tag does not match release version.');
  return release;
}
module.exports = { validate };
if (require.main === module) {
  const tag = process.argv[2] || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
  console.log(JSON.stringify(validate(tag)));
}
