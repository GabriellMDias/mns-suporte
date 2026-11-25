#!/bin/sh
(
  set -eu
  export MNS_MIGRATION_PASSWORD="$(cat /run/secrets/migration_password)"
  export MNS_RUNTIME_PASSWORD="$(cat /run/secrets/runtime_password)"
  export MNS_MAINTENANCE_PASSWORD="$(cat /run/secrets/maintenance_password)"
  test -n "$MNS_MIGRATION_PASSWORD"
  test -n "$MNS_RUNTIME_PASSWORD"
  test -n "$MNS_MAINTENANCE_PASSWORD"
  psql --no-psqlrc --set ON_ERROR_STOP=1 --single-transaction --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migration_password MNS_MIGRATION_PASSWORD
\getenv runtime_password MNS_RUNTIME_PASSWORD
\getenv maintenance_password MNS_MAINTENANCE_PASSWORD
CREATE ROLE mns_migration LOGIN PASSWORD :'migration_password';
CREATE ROLE orion_runtime LOGIN PASSWORD :'runtime_password';
CREATE ROLE mns_maintenance LOGIN PASSWORD :'maintenance_password';
ALTER DATABASE mns_suporte OWNER TO mns_migration;
REVOKE ALL ON DATABASE mns_suporte FROM PUBLIC;
GRANT CONNECT ON DATABASE mns_suporte TO orion_runtime, mns_maintenance;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO orion_runtime;
SQL
)
