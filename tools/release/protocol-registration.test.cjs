const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { execFileSync } = require('node:child_process');
const root = resolve(__dirname, '../..');
for (const channel of ['normal', 'private-beta']) test(`Linux ${channel} DEB registers the shared URI handler and passes the URL via %u`, { skip: process.platform !== 'linux' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'lion-protocol-deb-'));
  try {
    const executable = channel === 'normal' ? 'lionpocket' : 'lionpocket-beta', name = channel === 'normal' ? 'LionPocket' : 'LionPocket-Beta';
    mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, 'assets'));
    copyFileSync(join(root, 'apps/desktop/scripts/build-linux-deb.sh'), join(directory, 'scripts/build-linux-deb.sh'));
    copyFileSync(join(root, 'apps/desktop/assets/icon.png'), join(directory, 'assets/icon.png'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    const app = join(directory, 'out', `${name}-linux-x64`); mkdirSync(app, { recursive: true });
    writeFileSync(join(app, executable), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(app, 'chrome-sandbox'), '', { mode: 0o755 });
    execFileSync('bash', [join(directory, 'scripts/build-linux-deb.sh')], { env: { ...process.env, LIONPOCKET_BUILD_CHANNEL: channel }, stdio: 'pipe' });
    const deb = join(directory, 'out/make/deb/x64', `${executable}_0.0.1_amd64.deb`), extracted = join(directory, 'installed');
    execFileSync('dpkg-deb', ['-R', deb, extracted], { stdio: 'pipe' });
    const desktopPath = join(extracted, 'usr/share/applications', `${executable}.desktop`), desktop = readFileSync(desktopPath, 'utf8');
    assert.match(desktop, new RegExp(`^Exec=${executable} %u$`, 'm'));
    assert.match(desktop, /^MimeType=x-scheme-handler\/lionpocket;$/m);
    execFileSync('desktop-file-validate', [desktopPath]);
    for (const hook of ['postinst', 'postrm']) assert.match(readFileSync(join(extracted, 'DEBIAN', hook), 'utf8'), /update-desktop-database \/usr\/share\/applications/);
    assert.match(readFileSync(join(extracted, 'DEBIAN/control'), 'utf8'), /desktop-file-utils/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
