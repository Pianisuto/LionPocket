"""Read-only, paginated operational v4 staging commitment (never decrypts financial data)."""
import base64
import hashlib
import json
KEYS = {
    'sync_epoch_staging': ['restore_id', 'vault_id'],
    'sync_epoch_staging_batches': ['restore_id', 'vault_id', 'batch_ordinal'],
    'sync_epoch_staging_commits': ['restore_id', 'vault_id', 'ordinal'],
    'sync_epoch_staging_operations': ['restore_id', 'vault_id', 'op_id'],
    'sync_epoch_staging_heads': ['restore_id', 'vault_id', 'object_id', 'op_id'],
    'sync_epoch_transitions': ['restore_id', 'vault_id'],
}

def commitment(sql, cfg, database='lion_sync'):
    names = ','.join("'" + t + "'" for t in KEYS)
    present = int(sql(cfg, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN (" + names + ');', database))
    if present != len(KEYS):
        raise ValueError('Estrutura de staging incompleta.')
    digest = hashlib.sha256(b'LionPocket/operational-staging-backup/v1\n')
    for table, keys in KEYS.items():
        offset = 0
        digest.update((table + '\n').encode())
        while True:
            query = f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY {','.join(keys)}), '[]'::jsonb) FROM (SELECT * FROM {table} ORDER BY {','.join(keys)} LIMIT 100 OFFSET {offset}) t;"
            rows = json.loads(sql(cfg, query, database))
            if not rows:
                break
            for row in rows:
                field = {'sync_epoch_staging': 'begin_text', 'sync_epoch_staging_batches': 'batch_text', 'sync_epoch_staging_commits': 'envelope_text'}.get(table)
                if field:
                    expected = row['begin_sha256' if table == 'sync_epoch_staging' else 'digest']
                    actual = base64.urlsafe_b64encode(hashlib.sha256(row[field].encode()).digest()).decode().rstrip('=')
                    if actual != expected:
                        raise ValueError('Bytes de staging divergentes.')
                digest.update(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
                digest.update(b'\n')
            offset += len(rows)
    return digest.hexdigest()
