#!/usr/bin/env sh
set -eu

umask 077
key_file=/run/secrets/backup.key
action=${RESTORE_ACTION:-stage}
operation_id=${RESTORE_OPERATION_ID:-}

case "$action" in
  stage|prepare|commit|rollback) ;;
  *)
    echo "RESTORE_ACTION must be stage, prepare, commit, or rollback." >&2
    exit 1
    ;;
esac

case "$POSTGRES_DB" in
  ""|*[!A-Za-z0-9_]*)
    echo "POSTGRES_DB must be a simple PostgreSQL identifier." >&2
    exit 1
    ;;
esac
if [ "${#POSTGRES_DB}" -gt 24 ]; then
  echo "POSTGRES_DB is too long for a safe restore." >&2
  exit 1
fi

case "$operation_id" in
  ""|*[!A-Za-z0-9]*)
    echo "RESTORE_OPERATION_ID must be an alphanumeric local operation ID." >&2
    exit 1
    ;;
esac
if [ "${#operation_id}" -lt 8 ] || [ "${#operation_id}" -gt 24 ]; then
  echo "RESTORE_OPERATION_ID has an invalid length." >&2
  exit 1
fi

export PGPASSWORD=$POSTGRES_PASSWORD
temporary_database="${POSTGRES_DB}_restore_${operation_id}"
previous_database="${POSTGRES_DB}_before_${operation_id}"
failed_database="${POSTGRES_DB}_failed_${operation_id}"

database_exists() {
  psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
    --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "select exists(select 1 from pg_database where datname = '$1')" |
    grep -qx t
}

terminate_database() {
  psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()" >/dev/null
}

if [ "$action" = "rollback" ]; then
  if ! database_exists "$previous_database"; then
    echo "The retained pre-restore database is unavailable." >&2
    exit 1
  fi
  rollback_failed_created=0
  if database_exists "$POSTGRES_DB"; then
    if database_exists "$failed_database"; then
      echo "Rollback stopped because its reserved failed-database name already exists." >&2
      exit 1
    fi
    terminate_database "$POSTGRES_DB"
    psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
      --set ON_ERROR_STOP=1 \
      --command "alter database \"$POSTGRES_DB\" rename to \"$failed_database\""
    rollback_failed_created=1
  fi
  psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "alter database \"$previous_database\" rename to \"$POSTGRES_DB\""
  if [ "$rollback_failed_created" -eq 1 ]; then
    dropdb --force --host postgres --username "$POSTGRES_USER" \
      --maintenance-db postgres "$failed_database"
  fi
  echo "Restore operation $operation_id rolled back to the original database."
  exit 0
fi

if [ "$action" = "prepare" ]; then
  if ! database_exists "$previous_database"; then
    echo "The retained pre-restore database is unavailable." >&2
    exit 1
  fi
  psql --host postgres --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1 --command "truncate table worker_heartbeats" >/dev/null
  echo "Restore operation $operation_id is ready for a fresh worker heartbeat."
  exit 0
fi

if [ "$action" = "commit" ]; then
  if ! database_exists "$previous_database"; then
    echo "The retained pre-restore database is unavailable." >&2
    exit 1
  fi
  case "${RESTORE_FILE:-}" in
    hardware-*.dump.enc) ;;
    *)
      echo "RESTORE_FILE must identify the staged Hardware backup." >&2
      exit 1
      ;;
  esac
  case "$RESTORE_FILE" in
    *[!A-Za-z0-9._-]*)
      echo "RESTORE_FILE contains unsupported characters." >&2
      exit 1
      ;;
  esac
  dropdb --host postgres --username "$POSTGRES_USER" \
    --maintenance-db postgres "$previous_database"
  echo "Restore operation $operation_id committed."
  exit 0
fi

case "${RESTORE_FILE:-}" in
  hardware-*.dump.enc) ;;
  *)
    echo "RESTORE_FILE must be the basename of a Hardware encrypted backup." >&2
    exit 1
    ;;
esac
case "$RESTORE_FILE" in
  *[!A-Za-z0-9._-]*)
    echo "RESTORE_FILE contains unsupported characters." >&2
    exit 1
    ;;
esac

for reserved_database in "$temporary_database" "$previous_database" "$failed_database"; do
  if database_exists "$reserved_database"; then
    echo "Restore stopped because reserved database $reserved_database already exists." >&2
    exit 1
  fi
done

source_file="/backups/daily/$RESTORE_FILE"
if [ ! -f "$source_file" ]; then
  source_file="/backups/weekly/$RESTORE_FILE"
fi
if [ ! -f "$source_file" ] || [ ! -f "$source_file.sha256" ]; then
  echo "The requested backup or checksum does not exist." >&2
  exit 1
fi
if [ ! -r "$key_file" ]; then
  echo "Backup encryption key is unavailable." >&2
  exit 1
fi
key_length=$(wc -c < "$key_file" | tr -d ' ')
if [ "$key_length" -lt 32 ]; then
  echo "Backup encryption key must contain at least 32 bytes." >&2
  exit 1
fi

(cd "$(dirname "$source_file")" && sha256sum -c "$(basename "$source_file").sha256")
plain=$(mktemp /tmp/hardware-restore.XXXXXX.dump)
current_renamed=0
new_activated=0
stage_complete=0
temporary_created=0
failed_created=0
original_reactivated=0

cleanup() {
  rm -f "$plain"
  if [ "$current_renamed" -eq 1 ] && [ "$stage_complete" -eq 0 ]; then
    if [ "$new_activated" -eq 1 ]; then
      terminate_database "$POSTGRES_DB" >/dev/null 2>&1 || true
      if psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
        --set ON_ERROR_STOP=1 \
        --command "alter database \"$POSTGRES_DB\" rename to \"$failed_database\"" >/dev/null 2>&1; then
        failed_created=1
      fi
    fi
    if psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
      --set ON_ERROR_STOP=1 \
      --command "alter database \"$previous_database\" rename to \"$POSTGRES_DB\"" >/dev/null 2>&1; then
      original_reactivated=1
    fi
  fi
  if [ "$temporary_created" -eq 1 ] && database_exists "$temporary_database" >/dev/null 2>&1; then
    dropdb --if-exists --force --host postgres --username "$POSTGRES_USER" \
      --maintenance-db postgres "$temporary_database" >/dev/null 2>&1 || true
  fi
  if [ "$failed_created" -eq 1 ] && [ "$original_reactivated" -eq 1 ] && database_exists "$failed_database" >/dev/null 2>&1; then
    dropdb --if-exists --force --host postgres --username "$POSTGRES_USER" \
      --maintenance-db postgres "$failed_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -in "$source_file" \
  -out "$plain" \
  -pass "file:$key_file"
pg_restore --list "$plain" >/dev/null

# Restore and validate in isolation. The active database remains unchanged
# until the complete archive is readable and its essential catalog tables exist.
createdb --host postgres --username "$POSTGRES_USER" \
  --maintenance-db postgres "$temporary_database"
temporary_created=1
pg_restore \
  --host postgres \
  --username "$POSTGRES_USER" \
  --dbname "$temporary_database" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges \
  "$plain"

schema_ready=$(psql --host postgres --username "$POSTGRES_USER" \
  --dbname "$temporary_database" --tuples-only --no-align --set ON_ERROR_STOP=1 \
  --command "select to_regclass('public.users') is not null and to_regclass('public.projects') is not null and to_regclass('public.channel_sources') is not null")
if [ "$schema_ready" != "t" ]; then
  echo "The restored database failed the catalog schema check." >&2
  exit 1
fi

terminate_database "$POSTGRES_DB"
psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
  --set ON_ERROR_STOP=1 \
  --command "alter database \"$POSTGRES_DB\" rename to \"$previous_database\""
current_renamed=1
psql --host postgres --username "$POSTGRES_USER" --dbname postgres \
  --set ON_ERROR_STOP=1 \
  --command "alter database \"$temporary_database\" rename to \"$POSTGRES_DB\""
new_activated=1

if ! psql --host postgres --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 --command "select count(*) from projects" >/dev/null; then
  echo "The staged catalog failed its SQL smoke test." >&2
  exit 1
fi

stage_complete=1
echo "Restore staged from $RESTORE_FILE as operation $operation_id; the original database is retained pending application readiness."
