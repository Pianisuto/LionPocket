"""Read-only v4 commitments bind incomplete and prepared staging without plaintext."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest
spec = importlib.util.spec_from_file_location('staging_backup', Path(__file__).resolve().parents[2] / 'deploy/self-hosted/staging_backup.py')
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)

class StagingBackupTest(unittest.TestCase):
    def reader(self, tables=None, count=None):
        calls = []
        def sql(_cfg, query, database):
            calls.append(query)
            self.assertTrue(query.startswith('SELECT '))
            self.assertEqual(database, 'lp_verify_fixture')
            if 'pg_tables' in query:
                return str(len(staging.KEYS) if count is None else count)
            table = re.search(r'SELECT \* FROM (\w+)', query)[1]
            offset = int(re.search(r'OFFSET (\d+)', query)[1])
            return json.dumps((tables or {}).get(table, [])[offset:offset+100])
        return sql, calls

    def test_missing_or_partial_schema_is_not_v4(self):
        for count in [0, 3]:
            with self.assertRaisesRegex(ValueError, 'incompleta'):
                staging.commitment(self.reader(count=count)[0], {}, 'lp_verify_fixture')

    def test_pagination_and_byte_commitment(self):
        text = '{"ciphertext":"SYNTHETIC_CIPHERTEXT"}'
        digest = base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest()).decode().rstrip('=')
        tables = {'sync_epoch_staging_commits': [dict(ordinal=str(n), envelope_text=text, digest=digest) for n in range(205)]}
        sql, calls = self.reader(tables)
        first = staging.commitment(sql, {}, 'lp_verify_fixture')
        self.assertEqual(first, staging.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture'))
        self.assertTrue(any('OFFSET 200' in q for q in calls))
        tables['sync_epoch_staging_commits'][0]['envelope_text'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'divergentes'):
            staging.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture')

    def test_prepared_transition_and_incomplete_phase_are_committed(self):
        tables = {'sync_epoch_transitions': [{'state': 'prepared', 'transition_text': 'fixture'}]}
        first = staging.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture')
        tables['sync_epoch_transitions'][0]['transition_text'] = 'different'
        self.assertNotEqual(first, staging.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture'))
