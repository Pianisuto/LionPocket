#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv sync_password SYNC_PASSWORD
\getenv auth_password AUTH_PASSWORD
CREATE ROLE sync_api LOGIN PASSWORD :'sync_password';
CREATE ROLE keycloak LOGIN PASSWORD :'auth_password';
CREATE DATABASE lion_sync OWNER sync_api;
CREATE DATABASE lion_auth OWNER keycloak;
REVOKE ALL ON DATABASE lion_sync FROM PUBLIC;
REVOKE ALL ON DATABASE lion_auth FROM PUBLIC;
SQL
unset SYNC_PASSWORD AUTH_PASSWORD
