#!/usr/bin/env python3
"""Clean stack + TLS + official account/bootstrap/backup/restore operations, fixtures only."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import re
import secrets
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader('lpctl_module', str(ROOT / 'deploy/self-hosted/lpctl'))
spec = importlib.util.spec_from_loader(loader.name, loader)
lp = importlib.util.module_from_spec(spec)
loader.exec_module(lp)

with tempfile.TemporaryDirectory(prefix='lion-selfhost-fixture-') as temporary:
    directory = Path(temporary)
    os.chmod(directory, 0o700)
    (directory / "certificates").mkdir(mode=0o700)
    (directory / "caddy-config").mkdir(mode=0o700)
    env = directory / '.env'
    project = 'lion-selfhost-' + directory.name.rsplit('-', 1)[-1].lower()
    env.write_text('SYNC_HOST=sync.fixture.test\nAUTH_HOST=auth.fixture.test\nCOMPOSE_PROJECT_NAME=' + project + '\nREVERSE_PROXY=caddy\n' + ''.join(key + '=' + str(directory / key) + '\n' for key in lp.SECRET_KEYS))
    os.chmod(env, 0o600)
    lp.ENV = env
    os.environ.update(LP_ENV_FILE=str(env), LP_FIXTURE_DIR=str(directory), LP_COMPOSE_OVERRIDE=str(ROOT / 'tools/self-hosted/compose.fixture.yml'))
    executable = str(ROOT / 'deploy/self-hosted/lpctl')
    def ctl(*args, data=None):
        subprocess.run([executable, *args], input=data, check=True)
    def fixture(phase, untrusted=False):
        tls = ["-e", "NODE_EXTRA_CA_CERTS="] if untrusted else []
        result = lp.compose(cfg, 'run', '--rm', '-T', '--no-deps', *tls, 'fixture', phase, capture=True, check=False)
        print(result.stdout.decode())
        if result.returncode:
            print(result.stderr.decode())
            raise RuntimeError('Normal client fixture failed: ' + phase)
    def rotate_admin(password):
        next_file = directory / 'admin-next'
        next_file.write_bytes(password)
        next_file.chmod(0o600)
        try:
            lp.compose(cfg, 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'fixture', '/app/tools/self-hosted/rotate-fixture-admin.mjs', capture=True)
            Path(cfg['KEYCLOAK_ADMIN_PASSWORD_FILE']).write_bytes(password)
        finally:
            next_file.unlink(missing_ok=True)
    def active_snapshot():
        # pg_dump adds random \restrict guards, not database data. Ignore only
        # those two lines; compare every other byte of both logical databases.
        databases = {}
        for database in ['lion_sync', 'lion_auth']:
            dump = lp.compose(cfg, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', database, capture=True).stdout
            databases[database] = b'\n'.join(line for line in dump.splitlines() if not line.startswith((b'\\restrict ', b'\\unrestrict ')))
        raw = lp.compose(cfg, 'ps', '--format', 'json', '--no-trunc', capture=True).stdout.decode().strip()
        services = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines()]
        state = sorted((s['Service'], s['ID'], s['State'], s.get('Health')) for s in services)
        return {
            'env': env.read_bytes(), 'secrets': {key: Path(cfg[key]).read_bytes() for key in lp.SECRET_KEYS},
            'ca': root.read_bytes(), 'databases': databases, 'services': state,
            'identity': lp.sql(cfg, 'SELECT server_id::text,server_epoch::text FROM sync_environment;'),
            'names': lp.sql(cfg, 'SELECT datname FROM pg_database ORDER BY datname;', 'postgres'),
        }
    try:
        ctl('init')
        cfg = lp.config()
        lp.compose(cfg, 'config', '--quiet')
        # Avoid API/Keycloak TLS traffic before fixture CA has been created.
        lp.compose(cfg, 'up', '-d', '--build', '--wait', '--wait-timeout', '300', 'postgres', 'keycloak', 'api', 'caddy')
        # Caddy creates a private test CA. It is explicitly trusted by test runtimes,
        # never rejectUnauthorized=false or insecure fetch/curl flags.
        root = directory / 'certificates/caddy/pki/authorities/local/root.crt'
        for _ in range(30):
            if root.is_file():
                break
            time.sleep(1)
        if not root.is_file():
            raise RuntimeError('Fixture CA missing')
        with env.open('a') as stream: stream.write('HOMELAB_CA_FILE=' + str(root) + '\n')
        cfg = lp.config()
        # Exercise the official public-CA addon, not just the fixture mount.
        lp.compose(cfg, 'run', '--rm', '-T', '--no-deps', '-e', 'NODE_EXTRA_CA_CERTS=/opt/lionpocket/trusted-ca.pem', 'operator', data=b'{"action":"status"}', capture=True)
        ctl('status')
        for username in ['fixture-alice', 'fixture-mallory']:
            ctl('user', 'create', username, data=b'fixture-only-password-78931\n')
        fixture('initial')
        ctl('restart')
        fixture('restart')
        for phase in ['dns', 'expired']:
            fixture(phase)
        fixture('tls', untrusted=True)
        for service in ['api', 'keycloak', 'postgres']:
            lp.compose(cfg, 'stop', service, capture=True)
            fixture(service)
            lp.compose(cfg, 'up', '-d', '--wait', '--wait-timeout', '300', service)
        fixture('restart')  # Resume and drain every durable financial outbox.
        ctl('user', 'disable', 'fixture-alice')
        fixture('revoked')
        admin_a = Path(cfg['KEYCLOAK_ADMIN_PASSWORD_FILE']).read_bytes()
        admin_b = (secrets.token_urlsafe(48) + '\n').encode()
        assert admin_a != admin_b
        rotate_admin(admin_b)
        backup = directory / 'operational-backup'
        ctl('backup', str(backup))
        rotate_admin(admin_a)
        assert json.loads((backup / 'secrets.json').read_text())['KEYCLOAK_ADMIN_PASSWORD_FILE'].encode() == admin_b
        before_verify = active_snapshot()
        ctl('verify-backup', str(backup))
        assert active_snapshot() == before_verify, 'verify-backup modified active installation or left temporary databases'
        ctl('status')
        lp.operator(cfg, 'check-admin', '')  # Active admin A still authenticates.
        print('verify-backup with active A / backup B: all secret/config/database/identity/service bytes unchanged; temporary databases removed')
        corrupt = directory / 'corrupt-backup'
        shutil.copytree(backup, corrupt)
        with (corrupt / 'sync.dump').open('ab') as dump: dump.write(b'CORRUPTED_FIXTURE')
        before_corrupt = active_snapshot()
        check = subprocess.run([executable, 'verify-backup', str(corrupt)], capture_output=True)
        if check.returncode == 0: raise RuntimeError('Corrupt backup accepted')
        assert active_snapshot() == before_corrupt, 'Corrupt backup modified active installation'
        print('Corrupt backup rejected before any restore')
        # Canary scans the complete logical databases and every container log.
        for database in ['lion_sync', 'lion_auth']:
            dump = lp.compose(cfg, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', database, capture=True).stdout
            for canary in [b'LP_SELFHOST_CANARY_DESCRIPTION_72319', b'LP_SELFHOST_CANARY_NOTE_87931', b'9876543', b'98765.43']:
                if canary in dump:
                    raise RuntimeError('Financial canary leaked into server database')
        logs = lp.compose(cfg, 'logs', '--no-color', capture=True).stdout
        if re.search(rb'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', logs):
            raise RuntimeError('JWT appeared in stack logs')
        client = json.loads((directory / 'client-state.json').read_text())
        for device in ['desktop', 'android']:
            token = json.loads((directory / ('ephemeral-token-' + device + '.json')).read_text())['accessToken']
            if token.encode() in logs:
                raise RuntimeError('Access token leaked into logs')
        for canary in [b'LP_SELFHOST_CANARY_DESCRIPTION_72319', b'LP_SELFHOST_CANARY_NOTE_87931', client['recovery'].encode()]:
            if canary in logs:
                raise RuntimeError('Sensitive canary leaked into logs')
        print('Ciphertext/privacy canaries: both databases and stack logs passed')
        # Real server outage, all writers/readers remain local and outbox remains durable.
        lp.compose(cfg, 'stop', 'api', 'keycloak', 'postgres', capture=True)
        fixture('offline')
        lp.compose(cfg, 'up', '-d', '--wait', '--wait-timeout', '300', 'postgres', 'keycloak', 'api')
        # Recovery of operational state is destructive only within this temporary project.
        ctl('restore', str(backup), '--confirm-new-epoch')
        assert Path(cfg['KEYCLOAK_ADMIN_PASSWORD_FILE']).read_bytes() == admin_b, 'Confirmed restore did not restore admin B'
        fixture('epoch')
        ctl('user', 'create', 'fixture-after-restore', data=b'fixture-only-password-78931\n')
        ctl('status')
        print('Clean self-host install, normal client E2EE, restart, privacy, offline and backup/restore/epoch: passed')
    except Exception:
        # Only isolated fixture services: preserve useful startup errors before cleanup.
        print(lp.compose(cfg, "logs", "--tail", "80", "postgres", "keycloak", "api", "caddy", capture=True, check=False).stdout.decode())
        raise
    finally:
        cfg = lp.config(False)
        lp.compose(cfg, 'down', '--volumes', '--remove-orphans', capture=True, check=False)
