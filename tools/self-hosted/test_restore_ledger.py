import copy
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('restore_ledger_test', ROOT / 'deploy/self-hosted/restore_ledger.py')
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


def uid(n):
    return f'{n:08d}-1111-4111-8111-111111111111'


def history():
    result = {t: [] for t in ledger.TABLES}
    result['sync_restores'] = [dict(restore_id=uid(1), server_id=uid(2), from_epoch=uid(3), to_epoch=uid(4), displaced_epoch=uid(3), restored_at='2026-10-01T00:00:00+00:00', backup_manifest_sha256='a' * 64)]
    result['sync_restore_vaults'] = [dict(restore_id=uid(1), vault_id=uid(5), source_epoch=uid(3), state='awaiting_authority')]
    return result


class LedgerTest(unittest.TestCase):
    def test_multiple_restores_preserve_evidence_and_have_stable_digest(self):
        old = history()
        current = copy.deepcopy(old)
        current['sync_restores'].append(dict(current['sync_restores'][0], restore_id=uid(6), from_epoch=uid(4), to_epoch=uid(7), displaced_epoch=uid(4)))
        current['sync_restore_vaults'].append(dict(current['sync_restore_vaults'][0], restore_id=uid(6)))
        merged = ledger.merge(old, current)
        self.assertEqual(2, len(merged['sync_restores']))
        self.assertEqual(ledger.digest(current), ledger.digest(merged))
        self.assertEqual(old, history())

    def test_conflicting_record_is_never_overwritten(self):
        current = history()
        current['sync_restores'][0]['to_epoch'] = uid(8)
        with self.assertRaisesRegex(ValueError, 'conflitantes'):
            ledger.merge(history(), current)

    def test_partial_tables_and_broken_references_are_rejected(self):
        sql = Mock(return_value='2')
        with self.assertRaisesRegex(ValueError, 'incompleto'):
            ledger.snapshot(sql, {})
        for mutate in [lambda h: h['sync_restore_vaults'][0].update(restore_id=uid(9)),
                       lambda h: h['sync_restore_vaults'][0].update(state='authorized_awaiting_baseline'),
                       lambda h: h['sync_restores'].append(copy.deepcopy(h['sync_restores'][0]))]:
            fixture = history(); mutate(fixture)
            with self.assertRaises(ValueError):
                ledger.validate(fixture)

    def test_epoch_and_record_are_written_in_one_transaction_owned_by_api(self):
        sql = Mock(side_effect=[str(len(ledger.TABLES)), json.dumps({t: [] for t in ledger.TABLES}), ''])
        restore_id, epoch = ledger.record(sql, {}, 'CREATE TABLE IF NOT EXISTS fixture(id uuid);',
                                         dict(serverId=uid(2), serverEpoch=uid(3)), 'a' * 64, history(), uid(4))
        query = sql.call_args.args[1]
        self.assertTrue(query.startswith('BEGIN;'))
        self.assertTrue(query.endswith('COMMIT;'))
        self.assertIn('SET ROLE sync_api;', query)
        self.assertIn(restore_id, query)
        self.assertIn(epoch, query)
        self.assertIn('INSERT INTO sync_restore_vaults', query)
        self.assertNotIn('UPDATE sync_vaults', query)

    def test_prior_ledger_survives_process_loss_and_missing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'restore-ledger.json'
            def write(target, content):
                target.write_bytes(content)
            original = history()
            sql = Mock(side_effect=[uid(2)+'|'+uid(4), '4', json.dumps(original)])
            saved, epoch = ledger.preserve_before_restore(sql, {}, path, uid(2), write)
            self.assertEqual(original, saved)
            self.assertEqual(uid(4), epoch)
            # New process, after the old process dropped the live database.
            sql = Mock(side_effect=ValueError('missing database'))
            retried, displaced = ledger.preserve_before_restore(sql, {}, path, uid(2), write)
            self.assertEqual(saved, retried)
            self.assertEqual(epoch, displaced)
            with self.assertRaisesRegex(ValueError, 'outro servidor'):
                ledger.preserve_before_restore(sql, {}, path, uid(8), write)


if __name__ == '__main__':
    unittest.main()
