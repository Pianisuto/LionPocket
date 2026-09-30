const { execFileSync } = require('node:child_process');
const { copyFileSync, appendFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const target = resolve(process.argv[2] || '');
execFileSync(
  process.execPath,
  [
    join(__dirname, '../sync-stage1/prepare-android.cjs'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
copyFileSync(
  join(__dirname, 'android-transport.js'),
  join(target, 'apps/mobile/transport-checks.js'),
);
appendFileSync(
  join(target, 'apps/mobile/index.js'),
  "\nimport './transport-checks';\n",
);
