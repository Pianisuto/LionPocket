"""Synthetic, read-only checks of v3 generation archive verification."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('generation_backup', Path(__file__).resolve().parents[2] / 'deploy/self-hosted/generation_backup.py')
generations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generations)


class GenerationBackupTest(unittest.TestCase):
    def reader(self, tables=None, count=None, failed_check=False):
        calls = []
        def sql(_cfg, query, database):
            calls.append((query, database))
            self.assertEqual(database, 'lp_verify_fixture')
            self.assertTrue(query.startswith('SELECT '))
            if 'pg_tables' in query:
                return str(len(generations.KEYS) if count is None else count)
            if query.startswith('SELECT count(*)'):
                return '1' if failed_check else '0'
            table = re.search(r'SELECT \* FROM (\w+)', query)[1]
            offset = int(re.search(r'OFFSET (\d+)', query)[1])
            return json.dumps((tables or {}).get(table, [])[offset:offset+100])
        return sql, calls

    def test_legacy_absent_and_partial_schema(self):
        sql, calls = self.reader(count=0)
        self.assertIsNone(generations.commitment(sql, {}, 'lp_verify_fixture'))
        self.assertEqual(len(calls), 1)
        sql, _ = self.reader(count=2)
        with self.assertRaisesRegex(ValueError, 'incompleta'):
            generations.commitment(sql, {}, 'lp_verify_fixture')

    def test_deterministic_paginated_digest_and_exact_ciphertext(self):
        envelope = '{"ciphertext":"SYNTHETIC_CIPHERTEXT"}'
        digest = base64.urlsafe_b64encode(hashlib.sha256(envelope.encode()).digest()).decode().rstrip('=')
        tables = {'archive_sync_commits': [dict(commit_id=str(n), envelope_text=envelope, digest=digest) for n in range(205)]}
        sql, calls = self.reader(tables)
        first = generations.commitment(sql, {}, 'lp_verify_fixture')
        self.assertEqual(len(first), 64)
        self.assertEqual(first, generations.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture'))
        self.assertTrue(any('OFFSET 200' in q for q, _ in calls))
        tables['archive_sync_commits'][0]['envelope_text'] = 'modified ciphertext'
        with self.assertRaisesRegex(ValueError, 'Envelope arquivado divergente'):
            generations.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture')

    def test_missing_reference_or_unsealed_archive_fails_read_only(self):
        sql, _ = self.reader(failed_check=True)
        with self.assertRaisesRegex(ValueError, 'incompleto'):
            generations.commitment(sql, {}, 'lp_verify_fixture')

    def test_changed_public_metadata_changes_commitment(self):
        tables = {'sync_generations': [{'server_epoch': 'fixture', 'state': 'active', 'archive_sealed': True}]}
        first = generations.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture')
        tables['sync_generations'][0]['state'] = 'archived'
        self.assertNotEqual(first, generations.commitment(self.reader(tables)[0], {}, 'lp_verify_fixture'))
