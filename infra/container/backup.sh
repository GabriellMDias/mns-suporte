#!/bin/bash
set -Eeuo pipefail
umask 077
export PGHOST=db PGPORT=5432 PGUSER=mns_migration PGDATABASE=mns_suporte PGCONNECT_TIMEOUT=5
password="$(cat /run/secrets/database_password)"
export PGPASSWORD="${password%$'\r'}"

action="${1:-}"
name="${2:-}"
if [[ $# -ne 2 || ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,110}\.dump\.gpg$ ]]; then
  printf '%s\n' 'Usage: backup {create|restore} NAME.dump.gpg' >&2
  exit 2
fi

scratch="$(mktemp -d /scratch/mns-backup.XXXXXXXX)"
archive="/backups/$name"
temporary=""
stage="prepare"
trap 'test -z "$temporary" || rm -f -- "$temporary"; rm -rf -- "$scratch"' EXIT
trap 'printf "backup_operation_failed stage=%s\n" "$stage" >&2' ERR
mkdir "$scratch/gpg"
gpg_options=(--no-options --homedir "$scratch/gpg" --batch --no-tty --quiet --no-symkey-cache
  --pinentry-mode loopback --passphrase-file /run/secrets/backup_key)

case "$action" in
  create)
    temporary="$(mktemp /backups/.pending.XXXXXXXX)"
    stage="dump_and_encrypt"
    pg_dump --format=custom --no-password --lock-wait-timeout=10s 2>"$scratch/postgres.log" |
      gpg "${gpg_options[@]}" --symmetric --cipher-algo AES256 --compress-algo none --yes --output "$temporary" 2>"$scratch/gpg.log"
    # Publication is atomic and fails if this name already exists.
    stage="publish"
    ln -T -- "$temporary" "$archive" 2>"$scratch/publish.log"
    printf '%s\n' 'backup_created'
    ;;
  restore)
    stage="preflight"
    test -f "$archive"
    empty="$(psql -X --set=ON_ERROR_STOP=1 -Atc "SELECT to_regclass('public._prisma_migrations') IS NULL AND NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema IN ('public', 'mns_ops')) AND to_regnamespace('mns_ops') IS NULL" 2>"$scratch/postgres.log")"
    if [[ "$empty" != "t" ]]; then
      printf '%s\n' 'restore_requires_empty_database' >&2
      exit 3
    fi
    stage="decrypt"
    gpg "${gpg_options[@]}" --decrypt --output "$scratch/archive" "$archive" 2>"$scratch/gpg.log"
    stage="restore"
    pg_restore --single-transaction --no-owner --no-acl --no-password --dbname "$PGDATABASE" "$scratch/archive" 2>"$scratch/postgres.log"
    printf '%s\n' 'backup_restored'
    ;;
  *)
    printf '%s\n' 'Unknown backup operation' >&2
    exit 2
    ;;
esac
