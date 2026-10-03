import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('activation_backup', Path(__file__).resolve().parents[2] / 'deploy/self-hosted/activation_backup.py')
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)

class ActivationBackupTest(unittest.TestCase):
    def reader(self, rows, present='1'):
        calls = []
        def sql(_cfg, query, database):
            calls.append(query)
            self.assertTrue(query.startswith('SELECT '))
            self.assertEqual(database, 'lp_verify_fixture')
            if 'pg_tables' in query:
                return present
            offset = int(re.search(r'OFFSET (\d+)', query)[1])
            return json.dumps(rows[offset:offset+100])
        return sql, calls

    def test_activation_records_are_paged_committed_and_read_only(self):
        text = '{"activationId":"SYNTHETIC_PUBLIC_ONLY"}'
        digest = base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest()).decode().rstrip('=')
        rows = [dict(activation_id=str(n), request_text=text, request_sha256=digest, log_position=3) for n in range(205)]
        sql, calls = self.reader(rows)
        first = activation.commitment(sql, {}, 'lp_verify_fixture')
        self.assertTrue(any('OFFSET 200' in query for query in calls))
        rows[0]['log_position'] = 4
        self.assertNotEqual(first, activation.commitment(self.reader(rows)[0], {}, 'lp_verify_fixture'))
        rows[0]['request_text'] = 'tampered'
        with self.assertRaisesRegex(ValueError, 'divergente'):
            activation.commitment(self.reader(rows)[0], {}, 'lp_verify_fixture')
        with self.assertRaisesRegex(ValueError, 'ausente'):
            activation.commitment(self.reader([], '0')[0], {}, 'lp_verify_fixture')
