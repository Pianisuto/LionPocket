#!/usr/bin/env bash
# Run on LionsLab. Secrets and state stay in runtime/backups outside the checkout.
set -euo pipefail
runtime="${LION_BETA_RUNTIME:-$HOME/apps/lionpocket-beta/runtime}"
cd "$runtime"
case "${1:-}" in
  backup)
    destination="../backups/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -m 700 "$destination"
    docker compose exec -T postgres pg_dump -U lionbeta -Fc lion_sync > "$destination/sync.dump"
    docker compose exec -T postgres pg_dump -U lionbeta -Fc keycloak_beta > "$destination/keycloak.dump"
    cp .env compose.yml realm.json tunnel.yml "$destination/"
    chmod 600 "$destination"/*
    (cd "$destination" && sha256sum *.dump > SHA256SUMS)
    printf 'Backup: %s\n' "$destination"
    ;;
  verify-backup)
    backup="${2:?Specify a backup directory}"
    (cd "$backup" && sha256sum -c SHA256SUMS)
    suffix="$(date -u +%s)_$RANDOM"
    sync_database="beta_rehearsal_sync_$suffix"
    auth_database="beta_rehearsal_auth_$suffix"
    cleanup(){ docker compose exec -T postgres dropdb -U lionbeta --if-exists "$sync_database"; docker compose exec -T postgres dropdb -U lionbeta --if-exists "$auth_database"; }
    trap cleanup EXIT
    docker compose exec -T postgres createdb -U lionbeta "$sync_database"
    docker compose exec -T postgres pg_restore --exit-on-error -U lionbeta -d "$sync_database" < "$backup/sync.dump"
    docker compose exec -T postgres createdb -U lionbeta "$auth_database"
    docker compose exec -T postgres pg_restore --exit-on-error -U lionbeta -d "$auth_database" < "$backup/keycloak.dump"
    docker compose exec -T postgres psql -U lionbeta -d "$sync_database" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM sync_environment; SELECT count(*) FROM sync_commits;'
    docker compose exec -T postgres psql -U lionbeta -d "$auth_database" -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM realm;'
    printf 'Restore rehearsal completed in isolated databases.\n'
    ;;
  deploy|rollback)
    release="${2:?Specify an already built lionpocket-beta image tag}"
    [[ "$release" =~ ^lionpocket-beta:[a-zA-Z0-9_.-]+$ ]] || { printf 'Invalid release tag\n' >&2; exit 1; }
    docker image inspect "$release" > /dev/null
    cp -p .env ../backups/previous-deploy.env
    python3 - "$release" <<'PY'
import sys,os
p='.env';text=open(p).read();lines=text.splitlines();lines=[('API_IMAGE='+sys.argv[1]) if line.startswith('API_IMAGE=') else line for line in lines]
f=open(p+'.next','w');os.chmod(p+'.next',0o600);f.write('\n'.join(lines)+'\n');f.flush();os.fsync(f.fileno());f.close();os.replace(p+'.next',p)
PY
    docker compose up -d --wait api
    ;;
  restart) docker compose restart api keycloak; docker compose up -d --wait api ;;
  *) printf 'Usage: operate.sh backup | verify-backup DIR | deploy TAG | rollback TAG | restart\n' >&2; exit 2 ;;
esac
