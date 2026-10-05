#!/usr/bin/env bash
# Run on LionsLab. Secrets and state stay in runtime/backups outside the checkout.
set -euo pipefail
runtime="${LION_BETA_RUNTIME:-$HOME/apps/lionpocket-beta/runtime}"
cd "$runtime"

apply_theme() {
  [[ -f keycloak-theme/lionpocket/login/theme.properties ]] || {
    printf 'Tema Keycloak do LionPocket ausente em %s/keycloak-theme/lionpocket.\n' "$runtime" >&2
    return 1
  }
  docker compose up -d keycloak >/dev/null
  local ready=0
  for _ in {1..60}; do
    if docker compose exec -T keycloak bash -lc '/opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 --realm master --user beta-admin --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  [[ "$ready" == 1 ]] || { printf 'Keycloak beta não ficou pronto para aplicar o tema.\n' >&2; return 1; }
  docker compose exec -T keycloak bash -lc '/opt/keycloak/bin/kcadm.sh update realms/lionpocket-beta -s loginTheme=lionpocket -s displayName="LionPocket Beta" -s displayNameHtml="LionPocket Beta" -s internationalizationEnabled=true -s '"'"'supportedLocales=["pt-BR","en"]'"'"' -s defaultLocale=pt-BR >/dev/null'
}

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
    apply_theme
    ;;
  restart) docker compose restart api keycloak; docker compose up -d --wait api; apply_theme ;;
  theme) apply_theme ;;
  *) printf 'Usage: operate.sh backup | verify-backup DIR | deploy TAG | rollback TAG | restart | theme\n' >&2; exit 2 ;;
esac
