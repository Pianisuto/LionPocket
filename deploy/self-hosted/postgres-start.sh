#!/bin/sh
set -eu
# Compose file secrets retain host ownership. Read as root before the official
# entrypoint drops privileges; no password is passed on a command line.
export POSTGRES_PASSWORD="$(cat /run/secrets/postgres_password)"
export SYNC_PASSWORD="$(cat /run/secrets/sync_password)"
export AUTH_PASSWORD="$(cat /run/secrets/auth_password)"
exec /usr/local/bin/docker-entrypoint.sh postgres
