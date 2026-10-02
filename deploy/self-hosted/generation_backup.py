"""Read-only structural verification and paginated commitments of ciphertext generation archives."""
import base64
import hashlib
import json

KEYS = {
    'sync_generations': ['vault_id', 'server_epoch'],
    'archive_sync_vaults': ['generation_epoch', 'vault_id'],
    'archive_sync_grants': ['generation_epoch', 'vault_id', 'registry_version'],
    'archive_sync_pairings': ['generation_epoch', 'vault_id', 'device_id'],
    'archive_sync_deliveries': ['generation_epoch', 'vault_id', 'recipient_device_id'],
    'archive_sync_commits': ['generation_epoch', 'vault_id', 'commit_id'],
    'archive_sync_operations': ['generation_epoch', 'vault_id', 'op_id'],
    'archive_sync_remote_heads': ['generation_epoch', 'vault_id', 'object_id', 'op_id'],
    'archive_sync_remote_bindings': ['generation_epoch', 'binding_id'],
}


def commitment(sql, cfg, database='lion_sync'):
    names = ','.join("'" + t + "'" for t in KEYS)
    present = int(sql(cfg, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN (" + names + ');', database))
    if present == 0:
        return None  # Supported legacy v1/v2, before generation migration.
    if present != len(KEYS):
        raise ValueError('Estrutura de gerações incompleta.')
    checks = [
        "SELECT count(*) FROM sync_vaults v WHERE (SELECT count(*) FROM sync_generations g WHERE g.vault_id=v.vault_id AND g.state='active' AND g.server_epoch=(v.pin->>'serverEpoch')::uuid)<>1;",
        "SELECT count(*) FROM sync_generations g LEFT JOIN sync_vaults v USING(vault_id) WHERE v.vault_id IS NULL;",
        "SELECT count(*) FROM sync_generations g WHERE state='archived' AND NOT archive_sealed;",
        "SELECT count(*) FROM sync_generations g WHERE archive_sealed AND (SELECT count(*) FROM archive_sync_vaults a WHERE a.vault_id=g.vault_id AND a.generation_epoch=g.server_epoch)<>1;",
        "SELECT count(*) FROM archive_sync_vaults a WHERE a.generation_epoch<>(a.pin->>'serverEpoch')::uuid OR a.log_position<>(SELECT count(*) FROM archive_sync_commits c WHERE c.vault_id=a.vault_id AND c.generation_epoch=a.generation_epoch);",
        "SELECT count(*) FROM archive_sync_vaults a WHERE a.log_position>0 AND (a.log_position<>(SELECT max(c.log_position) FROM archive_sync_commits c WHERE c.vault_id=a.vault_id AND c.generation_epoch=a.generation_epoch) OR (SELECT min(c.log_position) FROM archive_sync_commits c WHERE c.vault_id=a.vault_id AND c.generation_epoch=a.generation_epoch)<>1 OR a.log_position<>(SELECT count(DISTINCT c.log_position) FROM archive_sync_commits c WHERE c.vault_id=a.vault_id AND c.generation_epoch=a.generation_epoch));",
        "SELECT count(*) FROM archive_sync_operations o LEFT JOIN archive_sync_commits c ON c.vault_id=o.vault_id AND c.generation_epoch=o.generation_epoch AND c.commit_id=o.commit_id WHERE c.commit_id IS NULL;",
        "SELECT count(*) FROM archive_sync_remote_heads h LEFT JOIN archive_sync_operations o ON o.vault_id=h.vault_id AND o.generation_epoch=h.generation_epoch AND o.op_id=h.op_id WHERE o.op_id IS NULL OR o.object_id<>h.object_id;",
        "SELECT count(*) FROM archive_sync_operations o CROSS JOIN LATERAL unnest(o.parents) p LEFT JOIN archive_sync_operations parent ON parent.vault_id=o.vault_id AND parent.generation_epoch=o.generation_epoch AND parent.op_id=p WHERE parent.op_id IS NULL OR parent.object_id<>o.object_id;",
        "SELECT count(*) FROM archive_sync_commits c WHERE c.digest<>c.receipt->>'envelopeSha256' OR c.generation_epoch<>(c.receipt->>'serverEpoch')::uuid OR c.generation_epoch<>(c.envelope_text::jsonb->>'serverEpoch')::uuid OR c.commit_id<>(c.envelope_text::jsonb->>'commitId')::uuid;",
    ]
    for table in KEYS:
        if table.startswith('archive_'):
            checks.append(f"SELECT count(*) FROM {table} a LEFT JOIN sync_generations g ON g.vault_id=a.vault_id AND g.server_epoch=a.generation_epoch WHERE g.vault_id IS NULL OR NOT g.archive_sealed;")
    for query in checks:
        if sql(cfg, query, database) != '0':
            raise ValueError('Arquivo de geração divergente ou incompleto.')
    digest = hashlib.sha256(b'LionPocket/operational-generation-backup/v1\n')
    for table, keys in KEYS.items():
        offset = 0
        digest.update((table + '\n').encode())
        while True:
            query = f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY {','.join(keys)}), '[]'::jsonb) FROM (SELECT * FROM {table} ORDER BY {','.join(keys)} LIMIT 100 OFFSET {offset}) t;"
            rows = json.loads(sql(cfg, query, database))
            if not rows:
                break
            for row in rows:
                if table == 'archive_sync_commits':
                    actual = base64.urlsafe_b64encode(hashlib.sha256(row['envelope_text'].encode()).digest()).decode().rstrip('=')
                    if actual != row['digest']:
                        raise ValueError('Envelope arquivado divergente.')
                digest.update(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
                digest.update(b'\n')
            offset += len(rows)
    return digest.hexdigest()
