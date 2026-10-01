#!/usr/bin/env python3
"""Real install -r on a disposable root-capable emulator; never a physical device.
Requires old APKs supplied by the operator (or generated from the base revision).
No clear-storage, uninstall, downgrade, personal data or signature workaround.
"""
import argparse, json, os, pathlib, sqlite3, subprocess, tempfile, time

p = argparse.ArgumentParser()
p.add_argument('--serial', required=True)
p.add_argument('--fixtures', required=True)
p.add_argument('--old-normal', required=True)
p.add_argument('--new-normal', required=True)
p.add_argument('--old-beta', required=True)
p.add_argument('--new-beta', required=True)
p.add_argument('--report', required=True)
a = p.parse_args()
if not a.serial.startswith('emulator-'):
    raise SystemExit('Only a disposable emulator is accepted; physical devices are refused.')
fixtures = pathlib.Path(a.fixtures).resolve()
if not fixtures.name.startswith('lion-release-fixtures-') or fixtures.parent != pathlib.Path(tempfile.gettempdir()):
    raise SystemExit('Disposable fixture directory required.')
def adb(*args, binary=False):
    return subprocess.check_output(['adb', '-s', a.serial, *args], text=not binary).strip() if not binary else subprocess.check_output(['adb', '-s', a.serial, *args])
def shell(command): return adb('shell', command)
if shell('getprop ro.kernel.qemu') != '1': raise SystemExit('Emulator guard failed.')
adb('root'); adb('wait-for-device')
results = []
for pkg, old, new, versions in [
    ('com.lionpocketmobile', a.old_normal, a.new_normal, [1, 4, 5, 8]),
    ('com.lionpocketmobile.beta', a.old_beta, a.new_beta, [8]),
]:
    # Refuse any already-present package in this emulator at the start.
    if shell('pm path ' + pkg + ' || true'): raise SystemExit('Use a fresh disposable AVD without LionPocket packages.')
    install_old = adb('install', old)
    adb('shell', 'am', 'start', '-n', pkg + '/com.lionpocketmobile.MainActivity')
    time.sleep(5)
    adb('shell', 'am', 'force-stop', pkg)
    uid = shell('stat -c %u /data/user/0/' + pkg)
    for index, version in enumerate(versions):
        # Fixture injection is offline preparation, before replacement. No user storage is cleared.
        target = '/data/user/0/' + pkg + '/files/lionpocket.sqlite'
        src = fixtures / ('v' + str(version) + '.sqlite')
        shell('mkdir -p /data/user/0/' + pkg + '/files')
        adb('push', str(src), '/data/local/tmp/lion-release-fixture.sqlite')
        shell('rm -f ' + target + '-wal ' + target + '-shm')
        shell('cp /data/local/tmp/lion-release-fixture.sqlite ' + target)
        shell('chown ' + uid + ':' + uid + ' ' + target + '; chmod 600 ' + target + '; restorecon ' + target)
        # Record source schema and every value of every existing column, including queues.
        before = json.loads((fixtures / ('v' + str(version) + '.json')).read_text())
        replacement = adb('install', '-r', new)
        adb('shell', 'am', 'start', '-n', pkg + '/com.lionpocketmobile.MainActivity')
        time.sleep(6)
        adb('shell', 'am', 'force-stop', pkg)
        with tempfile.TemporaryDirectory(prefix='lion-release-extracted-') as temp:
            local = pathlib.Path(temp) / 'after.sqlite'
            local.write_bytes(adb('exec-out', 'cat', target, binary=True))
            # Keep committed WAL for a consistent read after force-stop.
            for suffix in ['-wal', '-shm']:
                if shell('if [ -f ' + target + suffix + ' ]; then echo yes; fi') == 'yes':
                    (pathlib.Path(str(local) + suffix)).write_bytes(adb('exec-out', 'cat', target + suffix, binary=True))
            db = sqlite3.connect(local)
            current = db.execute('PRAGMA user_version').fetchone()[0]
            if current != 8: raise AssertionError('Product did not migrate fixture v' + str(version) + ': ' + str(current))
            checks = 0
            for table in before['tables']:
                names = table['columns']
                rows = [dict(zip(names, row)) for row in db.execute('SELECT ' + ','.join(names) + ' FROM ' + table['name'])]
                sort = lambda values: sorted(json.dumps(v, sort_keys=True, ensure_ascii=False) for v in values)
                if sort(rows) != sort(table['rows']):
                    raise AssertionError('Changed legacy records: ' + pkg + ' v' + str(version) + ' ' + table['name'])
                checks += len(rows)
            integrity = db.execute('PRAGMA integrity_check').fetchall()
            foreign = db.execute('PRAGMA foreign_key_check').fetchall()
            if integrity != [('ok',)] or foreign: raise AssertionError('Integrity/FK failure')
            db.close()
        results.append(dict(package=pkg, sourceSchema=version, targetSchema=current, oldInstall=install_old if index == 0 else 'current fixture installation', replacement=replacement, recordsCompared=checks, tablesCompared=len(before['tables']), integrity='ok', foreignKeyViolations=0, storageCleared=False))
pathlib.Path(a.report).write_text(json.dumps(dict(syntheticOnly=True, serial=a.serial, scenarios=results), indent=2) + '\n')
print(json.dumps(results))
