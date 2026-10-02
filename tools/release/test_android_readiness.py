import unittest
import subprocess
from unittest.mock import Mock, patch

from android_readiness import EmulatorDatabase, prepare_emulator_root, wait_for_readiness


class ReadinessTests(unittest.TestCase):
    def test_closed_adb_root_connection_requires_reconnected_root_and_boot(self):
        now, rooted, commands = [0], [False], []
        def execute(args, **kwargs):
            commands.append(args[3:])
            self.assertLessEqual(kwargs['timeout'], 5)
            if args[-1] == 'getprop ro.kernel.qemu': return '1\n'
            if args[-1] == 'id -u': return '0\n' if rooted[0] else '2000\n'
            if args[-1] == 'getprop sys.boot_completed': return '1\n'
            if args[-1] == 'root':
                rooted[0] = True
                raise subprocess.CalledProcessError(1, args, output='unable to connect for root: closed')
            raise AssertionError(args)
        prepare_emulator_root('emulator-5554', clock=lambda: now[0],
                              sleep=lambda seconds: now.__setitem__(0, now[0] + seconds), execute=execute)
        self.assertEqual(commands.count(['root']), 1)
        self.assertEqual(commands[-2:], [['shell', 'id -u'], ['shell', 'getprop sys.boot_completed']])

    def test_permanent_adb_failure_is_bounded_and_never_passes(self):
        now = [0]
        def execute(args, **kwargs):
            raise subprocess.CalledProcessError(1, args, output='device offline')
        with self.assertRaisesRegex(AssertionError, 'device offline'):
            prepare_emulator_root('emulator-5554', timeout=1, clock=lambda: now[0],
                                  sleep=lambda seconds: now.__setitem__(0, now[0] + seconds), execute=execute)
        self.assertEqual(now[0], 1)

    def test_root_setup_refuses_physical_devices_before_mutation(self):
        execute = Mock(return_value='0')
        with self.assertRaisesRegex(ValueError, 'Disposable emulator'):
            prepare_emulator_root('physical-device', execute=execute)
        execute.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'Emulator guard'):
            prepare_emulator_root('emulator-5554', execute=execute)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[0][-2:], ['shell', 'getprop ro.kernel.qemu'])

    def test_activity_launch_is_awaited_once_and_still_requires_database_readiness(self):
        observer = object.__new__(EmulatorDatabase)
        observer.package = 'com.lionpocketmobile'
        observer.adb = Mock(return_value='Status: ok')
        observer.observe = Mock()
        observer.diagnostics = Mock(return_value={})
        with patch('android_readiness.wait_for_readiness', return_value='ready') as wait:
            self.assertEqual(observer.start_and_wait(timeout=40), 'ready')
        observer.adb.assert_any_call('shell', 'am', 'start', '-W', '-n',
                                     'com.lionpocketmobile/com.lionpocketmobile.MainActivity', timeout=40)
        self.assertEqual(observer.adb.call_count, 2)  # clear logs and exactly one launch
        self.assertEqual(wait.call_args.kwargs['timeout'], 40)
        self.assertEqual(wait.call_args.kwargs['expected'], 8)

    def test_launch_timeout_fails_without_relaunch_and_preserves_diagnostics(self):
        observer = object.__new__(EmulatorDatabase)
        observer.package = 'com.lionpocketmobile'
        observer.adb = Mock(side_effect=['', subprocess.TimeoutExpired('am start', 1)])
        observer.diagnostics = Mock(return_value={'logcat': 'FATAL EXCEPTION from app UID'})
        with self.assertRaisesRegex(AssertionError, 'FATAL EXCEPTION from app UID'):
            observer.start_and_wait(timeout=1)
        self.assertEqual(observer.adb.call_count, 2)

    def test_diagnostics_collect_app_uid_logs_before_background_service_noise(self):
        observer = object.__new__(EmulatorDatabase)
        observer.package, observer.uid, observer.serial = 'com.lionpocketmobile', '10216', 'emulator-5554'
        observer.directory, observer.target = '/fixture', '/fixture/database'
        def shell(command):
            return 'FATAL EXCEPTION from app UID' if 'logcat' in command and '--uid=10216' in command else 'background service noise' * 2000
        observer.shell = Mock(side_effect=shell)
        self.assertEqual(observer.diagnostics()['logcat'], 'FATAL EXCEPTION from app UID')

    def wait(self, observe, timeout=10, diagnostics=lambda: {'logcat': 'diagnostic log'}):
        self.now = 0
        def sleep(seconds):
            self.now += seconds
        return wait_for_readiness(observe, diagnostics, timeout=timeout,
                                  clock=lambda: self.now, sleep=sleep)

    def test_delayed_startup_beyond_old_six_second_cutoff(self):
        def observe():
            ready = self.now >= 7
            return dict(pid='123', schema=8 if ready else 4, opened=ready, ready=ready)
        result = self.wait(observe)
        self.assertEqual(result['elapsedSeconds'], 7)
        self.assertEqual(result['observations'][0]['state']['schema'], 4)
        self.assertEqual(result['observations'][-1]['state']['schema'], 8)

    def test_v8_fixture_alone_is_not_readiness(self):
        result = self.wait(lambda: dict(pid='123', schema=8, opened=True, ready=self.now >= 2))
        self.assertEqual(result['elapsedSeconds'], 2)

    def test_wrong_database_cannot_pass(self):
        with self.assertRaisesRegex(AssertionError, 'Timed out'):
            self.wait(lambda: dict(pid='123', schema=8, opened=False, ready=True), timeout=1)

    def test_process_died_cannot_pass_and_timeout_contains_diagnostics(self):
        with self.assertRaises(AssertionError) as caught:
            self.wait(lambda: dict(pid=None, schema=4, opened=False, ready=False), timeout=1,
                      diagnostics=lambda: {'process': 'absent', 'logcat': 'AndroidRuntime FATAL EXCEPTION'})
        for value in ['"schema": 4', '"process": "absent"', 'AndroidRuntime FATAL EXCEPTION']:
            self.assertIn(value, str(caught.exception))

    def test_sqlite_lock_is_retried_without_changing_database(self):
        result = self.wait(lambda: dict(pid='123', schema=8 if self.now >= 1 else None,
                                       opened=True, ready=True, readError='locked' if self.now < 1 else None))
        self.assertEqual(result['elapsedSeconds'], 1)

    def test_initialization_error_fails_with_diagnostics(self):
        with self.assertRaisesRegex(AssertionError, 'initialization failed'):
            self.wait(lambda: dict(pid='123', schema=4, opened=False, ready=False, failed=True))
        self.assertEqual(self.now, 0)

    def test_future_schema_requires_the_actual_specific_rejection(self):
        failure = dict(pid='123', schema=99, opened=False, failed=True, failureText='future schema rejected')
        result = wait_for_readiness(lambda: failure, lambda: {}, expected=99,
                                    expected_failure='future schema rejected')
        self.assertLess(result['elapsedSeconds'], 1)
        with self.assertRaisesRegex(AssertionError, 'initialization failed'):
            wait_for_readiness(lambda: {**failure, 'failureText': 'permission denied'}, lambda: {},
                               expected=99, expected_failure='future schema rejected')

    def test_adb_failure_still_produces_bounded_timeout_diagnostics(self):
        def observe():
            raise subprocess.CalledProcessError(1, 'adb', output='device offline')
        with self.assertRaisesRegex(AssertionError, 'device offline'):
            self.wait(observe, timeout=1)
        self.assertEqual(self.now, 1)

    def test_stale_ready_marker_from_previous_pid_is_rejected(self):
        observer = object.__new__(EmulatorDatabase)
        observer.package = 'com.lionpocketmobile'
        observer.target = '/data/user/0/com.lionpocketmobile/files/lionpocket.sqlite'
        observer.schema = lambda: 8
        def shell(command):
            if command.startswith('pidof'): return '124'
            if command.startswith('stat'): return '65079:573568\n65079:573568'
            return '10-02 12:00:00.001  123  300 I ReactNativeJS: [LionPocket] database ready: lionpocket.sqlite schema=8'
        observer.shell = shell
        state = observer.observe()
        self.assertFalse(state['ready'])
        self.assertTrue(state['opened'])
        observer.shell = lambda command: shell(command).replace('  123  ', '  124  ')
        self.assertTrue(observer.observe()['ready'])
        observer.shell = lambda command: '65079:573568\n65079:999999' if command.startswith('stat') else shell(command)
        self.assertFalse(observer.observe()['opened'])

    def test_observer_reads_as_app_uid_with_sqlite_readonly_not_live_file_copy(self):
        observer = object.__new__(EmulatorDatabase)
        observer.target, observer.uid = '/data/user/0/com.lionpocketmobile/files/lionpocket.sqlite', '10216'
        observer.shell = Mock(return_value='8')
        self.assertEqual(observer.schema(), 8)
        command = observer.shell.call_args.args[0]
        self.assertIn('su 10216 /system/bin/sqlite3 -readonly', command)
        self.assertIn('PRAGMA query_only=ON; PRAGMA user_version;', command)
        self.assertNotIn('cp ', command)


if __name__ == '__main__':
    unittest.main()
