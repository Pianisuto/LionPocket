// No uploads. Candidates remain local to the runner until an authorized release.
const { readdirSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { validate } = require('./validate.cjs');
const root = resolve(process.argv[2] || 'release-candidates');
const extensions = process.argv.slice(3);
function files(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const artifacts = files(root).filter(path => /\.(apk|aab|exe|nupkg|zip|deb)$/.test(path) || /[\\/]RELEASES$/.test(path)).sort();
if (!artifacts.length || extensions.some(extension => !artifacts.some(path => path.endsWith(extension))))
  throw new Error('Missing expected release artifacts.');
const version = validate().version;
if (artifacts.some(path => /\.(apk|aab|nupkg|zip|deb)$/.test(path) && !path.includes(version))) throw new Error('Artifact version mismatch; use a clean candidate directory.');
const sums = artifacts.map(path => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(root, path).replaceAll('\\', '/')}`).join('\n') + '\n';
writeFileSync(join(root, 'SHA256SUMS.txt'), sums);
writeFileSync(join(root, 'build-manifest.json'), JSON.stringify({ ...validate(), channel: process.env.LIONPOCKET_BUILD_CHANNEL ?? 'test-candidates', source: process.env.GITHUB_SHA ?? require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), publicRelease: false, artifacts: artifacts.map(path => ({ path: relative(root, path).replaceAll('\\', '/'), channel: relative(root, path).split(require('node:path').sep).includes('private-beta') ? 'private-beta' : (process.env.LIONPOCKET_BUILD_CHANNEL ?? 'normal') })) }, null, 2) + '\n');
console.log(sums);
