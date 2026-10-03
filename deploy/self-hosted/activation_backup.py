"""Read-only v5 commitment of irreversible activation records. Cryptographic audit runs separately."""
import base64
import hashlib
import json


def commitment(sql, cfg, database='lion_sync'):
    if sql(cfg, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='sync_epoch_activations';", database) != '1':
        raise ValueError('Estrutura de activation ausente.')
    digest = hashlib.sha256(b'LionPocket/operational-activation-backup/v1\n')
    offset = 0
    while True:
        query = f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY activation_id),'[]'::jsonb) FROM (SELECT * FROM sync_epoch_activations ORDER BY activation_id LIMIT 100 OFFSET {offset}) t;"
        rows = json.loads(sql(cfg, query, database))
        if not rows:
            break
        for row in rows:
            actual = base64.urlsafe_b64encode(hashlib.sha256(row['request_text'].encode()).digest()).decode().rstrip('=')
            if actual != row['request_sha256']:
                raise ValueError('Request de activation divergente.')
            digest.update(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
            digest.update(b'\n')
        offset += len(rows)
    return digest.hexdigest()
