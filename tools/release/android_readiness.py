"""Bounded startup observation, only on the root-capable disposable release AVD.
SQLite reads use its locking/WAL protocol and the app UID, never raw live-file copies.
No retries of installation, process restart, storage clearing or migration writes.
"""
import json
import re
import shlex
import subprocess
import time

PACKAGES = ('com.lionpocketmobile', 'com.lionpocketmobile.beta')


def prepare_emulator_root(serial, *, timeout=20, clock=time.monotonic,
                          sleep=time.sleep, execute=subprocess.check_output):
    """Reconnect only the disposable ADB setup; require actual root before fixtures."""
    if not serial.startswith('emulator-'):
        raise ValueError('Disposable emulator only')
    started, last_error = clock(), 'ADB root has not become ready'
    def command(*args):
        remaining = timeout - (clock() - started)
        if remaining <= 0:
            raise subprocess.TimeoutExpired('adb', timeout)
        return execute(['adb', '-s', serial, *args], text=True,
                       stderr=subprocess.STDOUT, timeout=min(5, remaining)).strip()
    while clock() - started < timeout:
        try:
            if command('shell', 'getprop ro.kernel.qemu') != '1':
                raise ValueError('Emulator guard failed')
            if (command('shell', 'id -u') == '0'
                    and command('shell', 'getprop sys.boot_completed') == '1'):
                return
            # adbd can close the connection while switching UID, even when root succeeds.
            command('root')
            command('wait-for-device')
        except subprocess.SubprocessError as error:
            last_error = str(error) + '\n' + str(getattr(error, 'output', '') or '')
        sleep(min(.25, max(0, timeout - (clock() - started))))
    raise AssertionError('Disposable emulator ADB/root setup timed out: ' + last_error)


def wait_for_readiness(observe, diagnostics, *, expected=8, legacy=False,
                       expected_failure=None, timeout=60, clock=time.monotonic, sleep=time.sleep):
    started = clock()
    last = {}
    observations = []
    while clock() - started < timeout:
        try:
            last = observe()
        except subprocess.SubprocessError as error:
            last = dict(readError=str(error) + '\n' + str(getattr(error, 'output', '') or ''))
        state = {key: last.get(key) for key in ('pid', 'schema', 'opened', 'ready', 'failed', 'readError')}
        if not observations or observations[-1]['state'] != state:
            observations.append(dict(elapsed=round(clock() - started, 3), state=state))
        # Even a v8 fixture must be opened by this process; the file version alone
        # (or Running LionPocketMobile before React effects) is not startup readiness.
        if last.get('failed'):
            if (clock() - started < timeout and expected_failure and last.get('pid')
                    and last.get('schema') == expected and expected_failure in last.get('failureText', '')):
                return dict(elapsedSeconds=round(clock() - started, 3), observations=observations)
            reason = 'LionPocket database initialization failed'
            break
        if (not expected_failure and clock() - started < timeout and last.get('pid') and last.get('schema') == expected and last.get('opened')
                and last.get('ready') and (not legacy or last.get('running'))):
            return dict(elapsedSeconds=round(clock() - started, 3), observations=observations)
        sleep(min(.25, max(0, timeout - (clock() - started))))
    else:
        reason = 'Timed out waiting for LionPocket database readiness'
    detail = dict(reason=reason, expectedSchema=expected, found=last,
                  observations=observations, diagnostics=diagnostics())
    # Captured before the caller's cleanup force-stops the process.
    raise AssertionError(json.dumps(detail, ensure_ascii=False, indent=2))


class EmulatorDatabase:
    def __init__(self, serial, package):
        if not serial.startswith('emulator-') or package not in PACKAGES:
            raise ValueError('Disposable LionPocket emulator only')
        self.serial, self.package = serial, package
        self.directory = '/data/user/0/' + package
        self.target = self.directory + '/files/lionpocket.sqlite'
        if self.shell('getprop ro.kernel.qemu') != '1':
            raise ValueError('Emulator guard failed')
        self.uid = self.shell('stat -c %u ' + self.directory)
        if not self.uid.isdigit():
            raise ValueError('Missing package storage UID')

    def adb(self, *args, timeout=5):
        return subprocess.check_output(['adb', '-s', self.serial, *args],
                                       text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()

    def shell(self, command):
        return self.adb('shell', command)

    def schema(self):
        # -readonly refuses a missing DB; query_only adds a second write guard.
        # su prevents a root observer from creating root-owned WAL/SHM files.
        result = self.shell(shlex.join(['su', self.uid, '/system/bin/sqlite3',
                           '-readonly', self.target,
                           'PRAGMA query_only=ON; PRAGMA user_version;']))
        return int(result)

    def observe(self, legacy=False):
        result = dict(pid=None, schema=None, opened=False, ready=False, failed=False)
        try:
            result['schema'] = self.schema()
        except (subprocess.SubprocessError, ValueError) as error:
            result['readError'] = str(error) + '\n' + str(getattr(error, 'output', '') or '')
        pids = self.shell('pidof ' + self.package + ' || true').split()
        if len(pids) == 1 and pids[0].isdigit():
            pid = result['pid'] = pids[0]
            # /data/data and /data/user/0 can be bind mounts, not symlinks.
            # Compare device + inode of the actual FD, never a pathname substring.
            files = self.shell('stat -Lc %d:%i ' + self.target + ' /proc/' + pid + '/fd/* 2>/dev/null || true').splitlines()
            result['opened'] = len(files) > 1 and files[0] in files[1:]
            logs = self.shell('logcat -d -v threadtime -s ReactNativeJS:I AndroidRuntime:E ReactNative:E LionPocket:I')
            # Exact process identity: a ready marker from an earlier process cannot pass.
            own = '\n'.join(line for line in logs.splitlines()
                            if re.search(r'\s' + pid + r'\s+\d+\s+[VDIWEF]\s', line))
            result['running'] = 'Running "LionPocketMobile"' in own
            result['ready'] = result['running'] if legacy else '[LionPocket] database ready: lionpocket.sqlite schema=8' in own
            result['failed'] = '[LionPocket] database initialization failed: lionpocket.sqlite' in own
            if result['failed']:
                result['failureText'] = own
        return result

    def diagnostics(self):
        commands = {
            'package': 'pm path ' + self.package + '; dumpsys package ' + self.package + ' | grep -E "userId=|dataDir=|versionCode="',
            'process': 'pidof ' + self.package + '; for p in $(pidof ' + self.package + '); do cat /proc/$p/status | head -12; done',
            'files': 'stat -c "%n uid=%u inode=%i size=%s mtime=%y" ' + self.target + ' ' + self.target + '-wal ' + self.target + '-shm',
            'activity': 'dumpsys activity activities',
            # Background system services can evict the initial app crash from a shared tail.
            # Retain this app UID's native/JS events, including the first failed launch.
            'logcat': 'logcat -d -v threadtime --uid=' + self.uid,
        }
        output = dict(serial=self.serial, packageName=self.package, uid=self.uid, database=self.target)
        for name, command in commands.items():
            try:
                output[name] = self.shell(command + ' || true')[-16000:]
            except subprocess.SubprocessError as error:
                output[name] = str(error)
        return output

    def start_and_wait(self, legacy=False, timeout=60, expected=8, expected_failure=None):
        self.adb('logcat', '-c')
        try:
            # Await Android's single launch; never restart the product to make a check pass.
            launch = self.adb('shell', 'am', 'start', '-W', '-n',
                              self.package + '/com.lionpocketmobile.MainActivity', timeout=timeout)
        except subprocess.SubprocessError as error:
            raise AssertionError(json.dumps(dict(
                reason='Android activity launch failed',
                launch=str(error) + '\n' + str(getattr(error, 'output', '') or ''),
                diagnostics=self.diagnostics()), ensure_ascii=False, indent=2)) from error
        def diagnostic():
            return dict(launch=launch, **self.diagnostics())
        return wait_for_readiness(lambda: self.observe(legacy), diagnostic,
                                  legacy=legacy, timeout=timeout, expected=expected, expected_failure=expected_failure)
