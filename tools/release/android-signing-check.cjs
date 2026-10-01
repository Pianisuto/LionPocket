const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const cwd = resolve(__dirname, '../../apps/mobile/android');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LIONPOCKET_ANDROID_')));
const result = spawnSync(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:validateReleaseIdentity', '--no-daemon', '--max-workers=2'], { cwd, env, encoding: 'utf8' });
if (result.status === 0 || !(result.stdout + result.stderr).includes('Production signing required.'))
  throw new Error('Missing signing was not rejected with the expected explanation.');
console.log('PASS: public release refuses missing signing before bundling.');
