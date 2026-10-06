/** OS dispatch against installed packages in disposable CI; --packaged allows an isolated local probe. */
const { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, openSync, closeSync, copyFileSync, symlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { fixture } = require('./fixture.cjs');
const root = resolve(__dirname, '../..'), beta = process.env.LIONPOCKET_BUILD_CHANNEL === 'private-beta';
const name = beta ? 'LionPocket-Beta' : 'LionPocket', executable = beta ? 'lionpocket-beta' : 'lionpocket';
const packaged = process.argv.includes('--packaged');
const extracted = process.argv.includes('--deb-extracted');
const version = require('../release/validate.cjs').validate().version;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (!packaged && !extracted && process.env.CI !== 'true') throw new Error('Installed smoke requires disposable CI');
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'lion-pairing-smoke-'));
  const logPath = join(directory, 'app.log'), log = openSync(logPath, 'a');
  const env = { ...process.env, CI: 'true', LIONPOCKET_PAIRING_SMOKE_DIRECTORY: directory,
    ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: logPath, DEBUG: 'electron-squirrel-startup' };
  delete env.ELECTRON_RUN_AS_NODE;
  let pid, running;
  try {
    let binary;
    if (packaged) binary = join(root, 'apps/desktop/out', `${name}-${process.platform}-x64`, executable + (process.platform === 'win32' ? '.exe' : ''));
    else if (process.platform === 'linux') {
      const deb = join(root, `apps/desktop/out/make/deb/x64/${executable}_${version}_amd64.deb`);
      let desktopPath = `/usr/share/applications/${executable}.desktop`;
      binary = `/opt/${name}/${executable}`;
      if (extracted) {
        const installed = join(directory, 'installed');
        execFileSync('dpkg-deb', ['-x', deb, installed], { stdio: 'pipe' });
        binary = join(installed, 'opt', name, executable);
        desktopPath = join(installed, 'usr/share/applications', `${executable}.desktop`);
        const binDirectory = join(directory, 'bin'); mkdirSync(binDirectory);
        symlinkSync(binary, join(binDirectory, executable));
        env.PATH = binDirectory + ':' + env.PATH;
      } else execFileSync('sudo', ['dpkg', '-i', deb], { stdio: 'pipe' });
      const desktop = readFileSync(desktopPath, 'utf8');
      assert.match(desktop, new RegExp(`Exec=${executable} %u`));
      assert.match(desktop, /MimeType=x-scheme-handler\/lionpocket;/);
      execFileSync('desktop-file-validate', [desktopPath]);
      env.XDG_CONFIG_HOME = join(directory, 'xdg-config');
      env.XDG_DATA_HOME = join(directory, 'xdg-data');
      mkdirSync(env.XDG_CONFIG_HOME); mkdirSync(env.XDG_DATA_HOME);
      if (extracted) {
        const applications = join(env.XDG_DATA_HOME, 'applications'); mkdirSync(applications);
        copyFileSync(desktopPath, join(applications, `${executable}.desktop`));
        execFileSync('update-desktop-database', [applications], { env });
      }
      execFileSync('xdg-mime', ['default', `${executable}.desktop`, 'x-scheme-handler/lionpocket'], { env });
      assert.equal(execFileSync('xdg-mime', ['query', 'default', 'x-scheme-handler/lionpocket'], { env, encoding: 'utf8' }).trim(), `${executable}.desktop`);
    } else if (process.platform === 'win32') {
      binary = join(process.env.LOCALAPPDATA, beta ? 'lionpocket_beta' : 'lionpocket', `app-${version}`, `${executable}.exe`);
      const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\lionpocket\\shell\\open\\command', '/ve'], { encoding: 'utf8' });
      assert.ok(registry.toLowerCase().includes(binary.toLowerCase()));
      assert.match(registry, /"%1"/);
    } else throw new Error('Unsupported smoke platform');
    const open = link => {
      if (packaged) {
        running = spawn(binary, [link, ...(process.platform === 'linux' ? ['--password-store=basic'] : [])], { env, stdio: ['ignore', log, log] });
      } else if (process.platform === 'linux') {
        // GIO resolves the installed MIME handler and invokes the desktop entry's %u.
        const launcher = spawn('gio', ['open', link], { env, stdio: ['ignore', log, log] });
        launcher.on('error', () => {});
      } else {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process -FilePath $env:LION_PAIRING_URI'], { env: { ...env, LION_PAIRING_URI: link }, stdio: ['ignore', log, log], timeout: 30000 });
      }
    };
    const state = async predicate => {
      const until = Date.now() + 45000;
      while (Date.now() < until) {
        if (existsSync(join(directory, 'state.json'))) {
          try { const s = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')); if (predicate(s)) return s; } catch {}
        }
        await wait(150);
      }
      throw new Error('Native OS deep link expectation timed out');
    };
    const valid = await fixture(), expired = await fixture(Date.now() - 1000);
    open(valid.link);
    const cold = await state(s => s.confirmation && s.server && s.connectButtons === 1 && s.received === 1);
    pid = cold.pid;
    assert.equal(cold.manualInputs, 0); assert.equal(cold.requestCreated, false); assert.equal(cold.bound, false); assert.equal(cold.rawInviteVisible, false);
    open(valid.link); await state(s => s.received >= 2);
    open(valid.link);
    const warm = await state(s => s.received >= 3);
    assert.equal(warm.pid, pid); assert.equal(warm.windows, 1); assert.equal(warm.connectButtons, 1); assert.equal(warm.requestCreated, false);
    writeFileSync(join(directory, 'cancel'), '');
    const cancelled = await state(s => !s.dialogOpen);
    assert.equal(cancelled.requestCreated, false);
    rmSync(join(directory, 'cancel'));
    open(expired.link);
    const stale = await state(s => s.expired);
    assert.equal(stale.connectButtons, 0); assert.equal(stale.requestCreated, false);
    open('lionpocket://pair/LPV2.invalid');
    const invalid = await state(s => s.invalid);
    assert.equal(invalid.connectButtons, 0); assert.equal(invalid.requestCreated, false); assert.equal(invalid.pid, pid);
    const logs = readFileSync(logPath, 'utf8');
    for (const value of [valid.link, valid.capability, expired.link, expired.capability, valid.link.slice('lionpocket://pair/'.length)]) assert.ok(!logs.includes(value), 'LPV2 secret appeared in application logs');
    if (existsSync(join(directory, 'confirmation.png'))) copyFileSync(join(directory, 'confirmation.png'), join(tmpdir(), `lionpocket-${executable}-confirmation.png`));
    console.log(JSON.stringify({ installed: !packaged && !extracted, debExtracted: extracted, platform: process.platform, coldStart: true, warmStart: true, sameInstance: true, windows: 1, directConfirmation: true, cancelWithoutRequest: true, expired: true, invalid: true, secretsInLogs: false, accessBeforeApproval: false }));
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    else running?.kill();
    closeSync(log);
    await wait(500);
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Desktop OS pairing smoke failed (URI, capability and command arguments redacted).'); process.exitCode = 1; });
