"""Focused operation regressions; clean-install smoke separately uses real DB/IdP."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader('lpctl_tests', str(ROOT / 'deploy/self-hosted/lpctl'))
spec = importlib.util.spec_from_loader(loader.name, loader)
lp = importlib.util.module_from_spec(spec)
loader.exec_module(lp)


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='lp-operations-test-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.checkout = self.directory / 'checkout'
        self.base = self.checkout / 'deploy/self-hosted'
        self.base.mkdir(parents=True)
        self.env = self.base / '.env'
        self.cfg = {'SYNC_HOST': 'sync.fixture.test', 'AUTH_HOST': 'auth.fixture.test'}
        for key in lp.SECRET_KEYS:
            path = self.directory / 'external' / key
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b'ACTIVE_A_' + key.encode() + b'a' * 48 + b'\n')
            path.chmod(0o600)
            self.cfg[key] = str(path)
        self.save_env()
        for name, value in [('BASE', self.base), ('CHECKOUT', self.checkout), ('ENV', self.env)]:
            mock = patch.object(lp, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        self.backup = self.directory / 'backup'
        self.backup.mkdir()
        (self.backup / 'config.env').write_bytes(self.env.read_bytes())
        (self.backup / 'secrets.json').write_text(json.dumps({key: 'BACKUP_B_' + 'b' * 64 + '\n' for key in lp.SECRET_KEYS}))
        (self.backup / 'sync.dump').write_bytes(b'SYNTHETIC_SYNC_DUMP')
        (self.backup / 'auth.dump').write_bytes(b'SYNTHETIC_AUTH_DUMP')
        self.identity = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
        self.manifest = {'formatVersion': 5, 'restoreLedgerSha256': 'a'*64, 'generationArchiveSha256': 'b'*64, 'stagingSha256': 'c'*64, 'activationSha256': 'd'*64, 'serverId': self.identity[0], 'serverEpoch': self.identity[1],
                         'counts': {'vaults': 0, 'commits': 0, 'grants': 0},
                         'files': {name: lp.checksum(self.backup / name) for name in ['sync.dump', 'auth.dump', 'config.env', 'secrets.json']}}
        self.save_manifest()

    def save_env(self):
        self.env.write_text(''.join(f'{key}={value}\n' for key, value in self.cfg.items()))

    def save_manifest(self):
        (self.backup / 'manifest.json').write_text(json.dumps(self.manifest))

    def snapshot(self):
        return {path: (path.read_bytes(), path.stat().st_mode, path.stat().st_ino, path.stat().st_mtime_ns)
                for path in [self.env, *(Path(self.cfg[key]) for key in lp.SECRET_KEYS)]}

    def test_rehearsal_backup_b_does_not_touch_active_a_or_config(self):
        before = self.snapshot()
        databases = {'lion_sync': 'ACTIVE_SYNC', 'lion_auth': 'ACTIVE_AUTH'}
        original = databases.copy()
        epoch = self.identity[1]
        def compose(_cfg, *args, **kwargs):
            if 'createdb' in args:
                databases[args[-1]] = 'TEMP'
            elif 'dropdb' in args:
                databases.pop(args[-1], None)
            elif 'pg_restore' in args:
                self.assertTrue(args[-1].startswith('lp_verify_'))
            else:
                self.fail('Unexpected rehearsal operation')
            return subprocess.CompletedProcess(args, 0)
        def sql(_cfg, query, database):
            nonlocal epoch
            self.assertTrue(database.startswith('lp_verify_'))
            if 'pg_tables' in query:
                return '0'
            if 'server_id::text' in query:
                return '|'.join(self.identity)
            if 'json_build_object' in query:
                return json.dumps(self.manifest['counts'])
            if "name='lionpocket'" in query:
                return '1'
            if query.startswith('UPDATE'):
                epoch = query.split("'")[1]
                return ''
            return epoch
        with patch.object(lp, 'compose', side_effect=compose), patch.object(lp, 'sql', side_effect=sql), \
             patch.object(lp.ledger, 'snapshot', return_value={}), patch.object(lp.ledger, 'digest', return_value='a'*64), \
             patch.object(lp.generations, 'commitment', return_value='b'*64), patch.object(lp.staging, 'commitment', return_value='c'*64), \
             patch.object(lp.activations, 'commitment', return_value='d'*64), patch.object(lp, 'verify_staging'):
            lp.rehearsal(lp.config(), self.backup)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(original, databases)
        self.assertNotEqual(self.identity[1], epoch)

    def test_bad_checksum_rejected_before_any_database_or_file_change(self):
        before = self.snapshot()
        (self.backup / 'sync.dump').write_bytes(b'CORRUPTED')
        with patch.object(lp, 'compose') as compose, patch.object(lp, 'sql') as sql:
            with self.assertRaisesRegex(ValueError, 'Checksum'):
                lp.rehearsal(lp.config(), self.backup)
            compose.assert_not_called()
            sql.assert_not_called()
        self.assertEqual(before, self.snapshot())

    def test_invalid_backup_admin_rejected_without_changes(self):
        before = self.snapshot()
        (self.backup / 'secrets.json').write_text('{}')
        self.manifest['files']['secrets.json'] = lp.checksum(self.backup / 'secrets.json')
        self.save_manifest()
        with patch.object(lp, 'compose') as compose:
            with self.assertRaisesRegex(ValueError, 'administrativo'):
                lp.rehearsal(lp.config(), self.backup)
            compose.assert_not_called()
        self.assertEqual(before, self.snapshot())

    def test_rehearsal_failure_removes_both_temporary_databases(self):
        calls = []
        def compose(_cfg, *args, **kwargs):
            calls.append(args)
            if 'pg_restore' in args:
                raise ValueError('Synthetic dump error')
            return subprocess.CompletedProcess(args, 0)
        with patch.object(lp, 'compose', side_effect=compose):
            with self.assertRaisesRegex(ValueError, 'Synthetic dump'):
                lp.rehearsal(lp.config(), self.backup)
        self.assertEqual(2, len([args for args in calls if 'dropdb' in args]))

    def test_rehearsal_cleanup_failure_is_reported_after_both_drops_attempted(self):
        calls = []
        def compose(_cfg, *args, **kwargs):
            calls.append(args)
            if 'pg_restore' in args:
                raise ValueError('Synthetic dump error')
            return subprocess.CompletedProcess(args, 1 if 'dropdb' in args else 0)
        with patch.object(lp, 'compose', side_effect=compose):
            with self.assertRaisesRegex(ValueError, 'remover todos os bancos temporários'):
                lp.rehearsal(lp.config(), self.backup)
        self.assertEqual(2, len([args for args in calls if 'dropdb' in args]))

    def test_checkout_secret_paths_rejected_before_init_writes(self):
        external = self.snapshot()
        for secret in lp.SECRET_KEYS:
            for path in [self.base / 'secrets/admin', self.checkout / 'deploy/lionpocket-secrets/admin', Path('../lionpocket-secrets/admin')]:
                with self.subTest(secret=secret, path=path):
                    cfg = self.cfg.copy()
                    cfg[secret] = str(path)
                    self.env.write_text(''.join(f'{key}={value}\n' for key, value in cfg.items()))
                    with self.assertRaisesRegex(ValueError, 'fora do checkout'):
                        lp.config(False)
                    self.assertFalse((self.base / 'secrets').exists())
        for path, value in self.snapshot().items():
            if path != self.env:
                self.assertEqual(external[path], value)

    def test_external_symlink_into_checkout_rejected(self):
        inside = self.checkout / 'secrets'
        inside.mkdir()
        link = self.directory / 'external-link'
        link.symlink_to(inside, target_is_directory=True)
        self.cfg['KEYCLOAK_ADMIN_PASSWORD_FILE'] = str(link / 'admin')
        self.save_env()
        with self.assertRaisesRegex(ValueError, 'fora do checkout'):
            lp.config(False)

    def test_home_paths_resolved_for_compose_without_rewriting_env(self):
        self.cfg['KEYCLOAK_ADMIN_PASSWORD_FILE'] = '~/.local/share/lionpocket-sync/secrets/admin'
        self.save_env()
        before = self.env.read_bytes()
        cfg = lp.config(False)
        expected = str(Path(self.cfg['KEYCLOAK_ADMIN_PASSWORD_FILE']).expanduser().resolve())
        self.assertEqual(expected, cfg['KEYCLOAK_ADMIN_PASSWORD_FILE'])
        with patch.object(lp.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            lp.compose(cfg, 'config', '--quiet')
        self.assertEqual(expected, run.call_args.kwargs['env']['KEYCLOAK_ADMIN_PASSWORD_FILE'])
        self.assertEqual(before, self.env.read_bytes())

    def test_private_write_failure_preserves_old_secret_and_removes_temp(self):
        path = Path(self.cfg['KEYCLOAK_ADMIN_PASSWORD_FILE'])
        before = path.read_bytes()
        with patch.object(lp.os, 'fsync', side_effect=OSError('Synthetic disk error')):
            with self.assertRaises(OSError):
                lp.write_private(path, b'BACKUP_B')
        self.assertEqual(before, path.read_bytes())
        self.assertFalse(list(path.parent.glob('.lp-restore-*')))

    def test_restore_requires_confirmation_before_any_operation(self):
        before = self.snapshot()
        with patch.object(lp.sys, 'argv', ['lpctl', 'restore', str(self.backup)]), patch.object(lp, 'rehearsal') as rehearsal:
            with self.assertRaisesRegex(ValueError, 'confirm-new-epoch'):
                lp.main()
            rehearsal.assert_not_called()
        self.assertEqual(before, self.snapshot())

    def test_restore_failures_stop_writers_and_report_partial_restore(self):
        for failure in ['pg_restore', 'write', 'up', 'admin']:
            with self.subTest(failure=failure):
                calls = []
                def compose(_cfg, *args, **kwargs):
                    calls.append(args)
                    if args[0] != 'stop' and failure in args:
                        raise ValueError('Synthetic restore failure')
                    return subprocess.CompletedProcess(args, 0)
                write = patch.object(lp, 'write_private', side_effect=OSError('Synthetic disk error')) if failure == 'write' else patch.object(lp, 'write_private', wraps=lp.write_private)
                with patch.object(lp.sys, 'argv', ['lpctl', 'restore', str(self.backup), '--confirm-new-epoch']), \
                     patch.object(lp, 'rehearsal', return_value=self.manifest), patch.object(lp, 'compose', side_effect=compose), \
                     patch.object(lp, 'sql', return_value='|'.join(self.identity)), patch.object(lp.ledger, 'snapshot', return_value=None), patch.object(lp.ledger, 'record', return_value=('fixture', self.identity[1])), write, \
                     patch.object(lp, 'operator', side_effect=ValueError('Synthetic admin failure') if failure == 'admin' else None):
                    with self.assertRaisesRegex(ValueError, 'API/IdP permanecem parados'):
                        lp.main()
                self.assertEqual(('stop', 'api', 'keycloak'), calls[-1])
                if failure in ['pg_restore', 'write']:
                    self.assertFalse(any(args[0] == 'up' for args in calls))

    def test_restore_cannot_confirm_stop_requires_manual_intervention(self):
        for failure in [subprocess.CompletedProcess([], 1), OSError('Synthetic Docker unavailable')]:
            with self.subTest(failure=type(failure)):
                def compose(_cfg, *args, **kwargs):
                    if kwargs.get('check') is False:
                        if isinstance(failure, OSError):
                            raise failure
                        return failure
                    if 'pg_restore' in args:
                        raise ValueError('Synthetic restore failure')
                    return subprocess.CompletedProcess(args, 0)
                with patch.object(lp.sys, 'argv', ['lpctl', 'restore', str(self.backup), '--confirm-new-epoch']), \
                     patch.object(lp, 'rehearsal', return_value=self.manifest), patch.object(lp, 'compose', side_effect=compose), \
                     patch.object(lp, 'sql', return_value='|'.join(self.identity)), patch.object(lp.ledger, 'snapshot', return_value=None):
                    with self.assertRaisesRegex(ValueError, 'Pare-os manualmente imediatamente'):
                        lp.main()


if __name__ == '__main__':
    unittest.main()
