"""Public restore metadata only. No administrative activation or private keys."""
import hashlib
import json
import re
import uuid

TABLES = ['sync_restores', 'sync_restore_vaults', 'sync_epoch_challenges', 'sync_epoch_authorizations']


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(history):
    return hashlib.sha256(canonical(history).encode()).hexdigest()


def snapshot(sql, cfg, database='lion_sync'):
    present = sql(cfg, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN (" + ','.join("'" + t + "'" for t in TABLES) + ');', database)
    if present != str(len(TABLES)):
        raise ValueError('Registro de restaurações incompleto.')
    fields = []
    for table in TABLES:
        order = 'restore_id,vault_id' if table in ['sync_restore_vaults', 'sync_epoch_authorizations'] else 'challenge_id' if table == 'sync_epoch_challenges' else 'restore_id'
        fields += ["'" + table + "'", f"(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY {order}),'[]'::jsonb) FROM {table} t)"]
    result = json.loads(sql(cfg, "SET TIME ZONE 'UTC'; SELECT jsonb_build_object(" + ','.join(fields) + ');', database).splitlines()[-1])
    validate(result)
    return result


def canonical_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value or uuid.UUID(value).version != 4:
        raise ValueError('Identidade de restauração inválida.')


def validate(history):
    try:
        _validate(history)
    except (KeyError, TypeError, AttributeError):
        raise ValueError('Registro de restaurações inválido.') from None


def _validate(history):
    if set(history) != set(TABLES) or any(not isinstance(history[t], list) for t in TABLES):
        raise ValueError('Registro de restaurações inválido.')
    restores, vaults, challenges, seen = {}, {}, {}, set()
    for row in history['sync_restores']:
        for key in ['restore_id', 'server_id', 'from_epoch', 'to_epoch', 'displaced_epoch']:
            canonical_uuid(row[key])
        if row['from_epoch'] == row['to_epoch'] or row['displaced_epoch'] == row['to_epoch'] or row['restore_id'] in restores or not re.fullmatch('[0-9a-f]{64}', row['backup_manifest_sha256']):
            raise ValueError('Registro de restaurações divergente.')
        restores[row['restore_id']] = row
    if len({r['to_epoch'] for r in restores.values()}) != len(restores):
        raise ValueError('Epoch de restauração duplicado.')
    if len({r['server_id'] for r in restores.values()}) > 1:
        raise ValueError('Registro contém servidores diferentes.')
    for row in history['sync_restore_vaults']:
        key = (row['restore_id'], row['vault_id'])
        if row['restore_id'] not in restores or key in vaults or row['state'] not in ['awaiting_authority', 'authorized_awaiting_baseline', 'recovered']:
            raise ValueError('Estado de recuperação inválido.')
        canonical_uuid(row['vault_id']); canonical_uuid(row['source_epoch'])
        vaults[key] = row
    for row in history['sync_epoch_challenges']:
        challenge, restore = row['challenge'], restores.get(row['restore_id'])
        canonical_uuid(row['challenge_id'])
        expected = dict(challengeId=row['challenge_id'], restoreId=row['restore_id'], vaultId=row['vault_id'])
        if restore:
            expected.update(serverId=restore['server_id'], fromEpoch=restore['from_epoch'], toEpoch=restore['to_epoch'])
        if not restore or (row['restore_id'], row['vault_id']) not in vaults or row['challenge_id'] in challenges or any(challenge[k] != v for k, v in expected.items()) or challenge['formatVersion'] != 1 or type(row['consumed']) is not bool:
            raise ValueError('Challenge de restauração divergente.')
        challenges[row['challenge_id']] = row
    for row in history['sync_epoch_authorizations']:
        key, challenge = (row['restore_id'], row['vault_id']), challenges.get(row['challenge_id'])
        authorization = row['authorization_envelope']
        if not challenge or key != (challenge['restore_id'], challenge['vault_id']) or not challenge['consumed'] or key in seen or key not in vaults or vaults[key]['state'] == 'awaiting_authority' or any(authorization.get(k) != v for k, v in challenge['challenge'].items()) or authorization.get('intent') != 'prepare-recovery' or not isinstance(row['known_grants'], list):
            raise ValueError('Autorização de restauração divergente.')
        seen.add(key)
    if any(v['state'] != 'awaiting_authority' and key not in seen for key, v in vaults.items()):
        raise ValueError('Autorização de restauração ausente.')


def merge(backup, live):
    merged = {t: [] for t in TABLES}
    for table in TABLES:
        rows = {}
        for row in [*(backup or {}).get(table, []), *(live or {}).get(table, [])]:
            keys = ['restore_id', 'vault_id'] if table in ['sync_restore_vaults', 'sync_epoch_authorizations'] else ['challenge_id'] if table == 'sync_epoch_challenges' else ['restore_id']
            key, old = tuple(row[k] for k in keys), rows.get(tuple(row[k] for k in keys))
            if old and old != row:
                ignored = 'state' if table == 'sync_restore_vaults' else 'consumed' if table == 'sync_epoch_challenges' else None
                if ignored and {k: v for k, v in old.items() if k != ignored} == {k: v for k, v in row.items() if k != ignored}:
                    states = ['awaiting_authority', 'authorized_awaiting_baseline', 'recovered']
                    row = dict(row, **{ignored: max([old['state'], row['state']], key=states.index) if ignored == 'state' else old['consumed'] or row['consumed']})
                else:
                    raise ValueError('Históricos de restauração conflitantes. Preserve ambos os backups para revisão.')
            rows[key] = row
        merged[table] = [rows[k] for k in sorted(rows)]
    validate(merged)
    return merged


def record(sql, cfg, schema, manifest, manifest_digest, live, displaced_epoch):
    merged = merge(snapshot(sql, cfg), live)
    epoch, restore_id = str(uuid.uuid4()), str(uuid.uuid4())
    statements = ['BEGIN;', 'SET ROLE sync_api;', schema]
    for table in TABLES:
        # Fixed names; public JSON is literal-escaped and sent through stdin, never shell evaluated.
        payload = canonical(merged[table]).replace("'", "''")
        statements.append(f"INSERT INTO {table} SELECT * FROM jsonb_populate_recordset(NULL::{table},'{payload}'::jsonb) ON CONFLICT DO NOTHING;")
        field = 'state' if table == 'sync_restore_vaults' else 'consumed' if table == 'sync_epoch_challenges' else None
        if field:
            key = 't.restore_id=s.restore_id AND t.vault_id=s.vault_id' if field == 'state' else 't.challenge_id=s.challenge_id'
            statements.append(f"UPDATE {table} t SET {field}=s.{field} FROM jsonb_populate_recordset(NULL::{table},'{payload}'::jsonb) s WHERE {key};")
    for identifier in [manifest['serverId'], manifest['serverEpoch'], displaced_epoch]:
        canonical_uuid(identifier)
    if not re.fullmatch('[0-9a-f]{64}', manifest_digest):
        raise ValueError('Manifesto de restauração inválido.')
    statements.extend([
        f"INSERT INTO sync_restores(restore_id,server_id,from_epoch,to_epoch,displaced_epoch,backup_manifest_sha256) VALUES('{restore_id}','{manifest['serverId']}','{manifest['serverEpoch']}','{epoch}','{displaced_epoch}','{manifest_digest}');",
        f"INSERT INTO sync_restore_vaults(restore_id,vault_id,source_epoch) SELECT '{restore_id}',vault_id,(pin->>'serverEpoch')::uuid FROM sync_vaults;",
        f"UPDATE sync_environment SET server_epoch='{epoch}' WHERE singleton;", 'COMMIT;',
    ])
    sql(cfg, '\n'.join(statements))
    return restore_id, epoch


def preserve_before_restore(sql, cfg, path, server_id, write_private):
    """Crash journal outside the replaceable database, before any destructive step."""
    journal = json.loads(path.read_text()) if path.exists() else None
    if journal is not None:
        if set(journal) != {'serverId', 'serverEpoch', 'history'} or journal['serverId'] != server_id:
            raise ValueError('Journal de restauração pertence a outro servidor. Preserve-o para revisão.')
        canonical_uuid(journal['serverEpoch'])
        validate(journal['history'])
    try:
        current = sql(cfg, 'SELECT server_id::text,server_epoch::text FROM sync_environment;').split('|')
    except (ValueError, OSError):
        if journal is None:
            raise
        # A previous confirmed restore may have crashed after dropdb.
        current, live = [server_id, journal['serverEpoch']], None
    else:
        for identity in current:
            canonical_uuid(identity)
        if len(current) != 2:
            raise ValueError('Identidade operacional inválida.')
        live = snapshot(sql, cfg)
        if current[0] != server_id:
            if journal is not None or (live and any(live[t] for t in TABLES)):
                raise ValueError('Restore de outro serverId exige instalação separada.')
            live = None
    history = merge(live, journal['history'] if journal is not None else None)
    if any(r['server_id'] != server_id for r in history['sync_restores']):
        raise ValueError('Registro de restaurações pertence a outro servidor.')
    write_private(path, canonical(dict(serverId=server_id, serverEpoch=current[1], history=history)).encode())
    return history, current[1]
