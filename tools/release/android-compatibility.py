#!/usr/bin/env python3
"""After the matrix, exercise signature refusal, final candidates and future schema."""
import argparse, json, pathlib, sqlite3, subprocess, tempfile
from android_readiness import EmulatorDatabase
p = argparse.ArgumentParser()
p.add_argument('--serial', required=True)
p.add_argument('--expected-schema', required=True, type=int)
p.add_argument('--mismatch-apk', required=True)
p.add_argument('--new-normal')
p.add_argument('--new-beta')
p.add_argument('--report', required=True)
a = p.parse_args()
if not a.serial.startswith('emulator-'): raise SystemExit('Disposable emulator only.')
def adb(*args): return subprocess.check_output(['adb', '-s', a.serial, *args])
def shell(command): return adb('shell', command).decode().strip()
if shell('getprop ro.kernel.qemu') != '1': raise SystemExit('Emulator guard failed.')
def snapshot(pkg, directory):
    adb('shell', 'am', 'force-stop', pkg)
    target = '/data/user/0/' + pkg + '/files/lionpocket.sqlite'
    file = pathlib.Path(directory) / (pkg + '.sqlite')
    file.write_bytes(adb('exec-out', 'cat', target))
    for suffix in ['-wal', '-shm']:
        if shell('if [ -f ' + target + suffix + ' ]; then echo yes; fi') == 'yes':
            pathlib.Path(str(file) + suffix).write_bytes(adb('exec-out', 'cat', target + suffix))
    db = sqlite3.connect(file)
    marker = db.execute("SELECT value FROM local_preferences WHERE key='release-fixture'").fetchone()
    if not marker: raise SystemExit('Only previously prepared synthetic fixtures accepted.')
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    result = dict(version=db.execute('PRAGMA user_version').fetchone()[0], tables={table: sorted(json.dumps(row, ensure_ascii=False) for row in db.execute('SELECT * FROM ' + table)) for table in tables})
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchall(): raise AssertionError('Integrity failed')
    db.close()
    return result, file
reports = []
with tempfile.TemporaryDirectory(prefix='lion-release-compatibility-') as directory:
    for pkg, new in [('com.lionpocketmobile', a.new_normal), ('com.lionpocketmobile.beta', a.new_beta)]:
        before, _ = snapshot(pkg, directory)
        if new:
            result = adb('install', '-r', new).decode()
            EmulatorDatabase(a.serial, pkg, a.expected_schema).start_and_wait()
            after, _ = snapshot(pkg, directory)
            if before != after: raise AssertionError('Final APK changed synthetic database')
            reports.append(dict(package=pkg, finalApkReplacement='Success', allTablesPreserved=True))
    pkg = 'com.lionpocketmobile'
    before, file = snapshot(pkg, directory)
    result = subprocess.run(['adb', '-s', a.serial, 'install', '-r', a.mismatch_apk], capture_output=True, text=True)
    if result.returncode == 0 or 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' not in result.stdout + result.stderr:
        raise AssertionError('Expected Android signature refusal')
    after, _ = snapshot(pkg, directory)
    if before != after: raise AssertionError('Signature failure changed database')
    reports.append(dict(signatureMismatch='INSTALL_FAILED_UPDATE_INCOMPATIBLE', databasePreserved=True, uninstall=False))
    # Prepare the future schema in the offline disposable fixture, then open it.
    db = sqlite3.connect(file); db.execute('PRAGMA user_version=99'); db.commit(); db.close()
    target = '/data/user/0/' + pkg + '/files/lionpocket.sqlite'
    uid = shell('stat -c %u /data/user/0/' + pkg)
    adb('push', str(file), '/data/local/tmp/lion-release-future.sqlite')
    shell('rm -f ' + target + '-wal ' + target + '-shm')
    shell('cp /data/local/tmp/lion-release-future.sqlite ' + target)
    shell('chown ' + uid + ':' + uid + ' ' + target + '; chmod 600 ' + target + '; restorecon ' + target)
    future, _ = snapshot(pkg, directory)
    # A schema-99 file remaining unchanged is not proof that the app opened it.
    # Require the real initialization's explicit future-schema rejection.
    readiness = EmulatorDatabase(a.serial, pkg, a.expected_schema).start_and_wait(expected=99, expected_failure='O banco foi criado por uma versão mais nova do LionPocket.')
    opened, _ = snapshot(pkg, directory)
    if future != opened or opened['version'] != 99: raise AssertionError('Future schema was modified')
    reports.append(dict(futureSchema=99, allTablesPreserved=True, versionPreserved=True, integrity='ok', foreignKeyViolations=0, readiness=readiness))
pathlib.Path(a.report).write_text(json.dumps(reports, indent=2) + '\n')
print(json.dumps(reports))
