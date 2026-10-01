#!/usr/bin/env python3
"""Compose validation with external disposable secrets, no service startup."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import tempfile
ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader('lpctl_validation', str(ROOT / 'deploy/self-hosted/lpctl'))
spec = importlib.util.spec_from_loader(loader.name, loader)
lp = importlib.util.module_from_spec(spec)
loader.exec_module(lp)
with tempfile.TemporaryDirectory(prefix='lp-compose-validation-') as temporary:
    directory = Path(temporary)
    for key in lp.SECRET_KEYS:
        (directory / key).write_text('DISPOSABLE_VALIDATION_ONLY_' + 'a' * 40)
        (directory / key).chmod(0o600)
    for mode in ['caddy', 'existing']:
        lp.ENV = directory / '.env'
        lp.ENV.write_text('SYNC_HOST=sync.fixture.test\nAUTH_HOST=auth.fixture.test\nREVERSE_PROXY=' + mode + '\n' + ''.join(key + '=' + str(directory / key) + '\n' for key in lp.SECRET_KEYS))
        cfg = lp.config()
        lp.compose(cfg, 'config', '--quiet')
    ca = directory / 'public-root-fixture.pem'
    ca.write_text('-----BEGIN CERTIFICATE-----\nCOMPOSE_VALIDATION_ONLY\n-----END CERTIFICATE-----\n')
    with lp.ENV.open('a') as stream: stream.write('HOMELAB_CA_FILE=' + str(ca) + '\n')
    lp.compose(lp.config(), 'config', '--quiet')
    print('Compose validated: Caddy, existing reverse proxy and public-CA addon; external fixture secrets.')
