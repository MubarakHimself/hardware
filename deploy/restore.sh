#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PBKDF2_ITERATIONS=600000
readonly BACKUP_CIPHER=aes-256-cbc

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

validate_key_file() {
  local key_file=$1
  local key_mode key_owner line_count first_line_length
  [[ $key_file = /* ]] || fail "BACKUP_ENCRYPTION_KEY_FILE must be an absolute path."
  [[ -f $key_file && ! -L $key_file ]] || fail "Backup encryption key must be a regular, non-symlink file."
  key_mode=$(stat -c '%a' -- "$key_file")
  [[ $key_mode == 400 || $key_mode == 600 ]] || fail "Backup encryption key mode must be 0400 or 0600."
  key_owner=$(stat -c '%u' -- "$key_file")
  [[ $key_owner == "$(id -u)" ]] || fail "Backup encryption key must be owned by the restore service user."
  line_count=$(awk 'END { print NR }' "$key_file")
  first_line_length=$(awk 'NR == 1 { print length($0); exit }' "$key_file")
  [[ $line_count == 1 && $first_line_length -ge 32 ]] || fail "Backup encryption key must contain one line of at least 32 characters."
}

verify_manifest() {
  local file=$1
  local manifest="$file.sha256"
  local expected _ actual_output actual manifest_size
  [[ -f $manifest && ! -L $manifest ]] || fail "Required checksum manifest is missing: $manifest"
  manifest_size=$(stat -c '%s' -- "$manifest")
  [[ $manifest_size -gt 0 && $manifest_size -le 1024 ]] || fail "Checksum manifest has an invalid size."
  IFS=' ' read -r expected _ <"$manifest" || fail "Checksum manifest is unreadable."
  [[ $expected =~ ^[[:xdigit:]]{64}$ ]] || fail "Checksum manifest does not contain a SHA-256 digest."
  actual_output=$(sha256sum -- "$file")
  actual=${actual_output%% *}
  [[ ${expected,,} == "${actual,,}" ]] || fail "Encrypted backup checksum verification failed."
}

if [[ ${CONFIRM_RESTORE:-} != hardware ]]; then
  fail "Restore is destructive. Re-run with CONFIRM_RESTORE=hardware."
fi
if [[ $# -ne 1 ]]; then
  fail "Usage: CONFIRM_RESTORE=hardware deploy/restore.sh /absolute/path/to/backup.dump.enc"
fi

readonly backup_file=$1
[[ $backup_file = /* ]] || fail "Backup path must be absolute."
[[ -f $backup_file && ! -L $backup_file ]] || fail "Encrypted backup must be a regular, non-symlink file: $backup_file"

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-"$PROJECT_DIR/.env.production"}
[[ -f $ENV_FILE ]] || fail "Missing production environment file: $ENV_FILE"

cd "$PROJECT_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

require_command awk
require_command docker
require_command openssl
require_command sha256sum
require_command stat

BACKUP_ENCRYPTION_KEY_FILE=${BACKUP_ENCRYPTION_KEY_FILE:-}
[[ -n $BACKUP_ENCRYPTION_KEY_FILE ]] || fail "BACKUP_ENCRYPTION_KEY_FILE is required."
validate_key_file "$BACKUP_ENCRYPTION_KEY_FILE"
verify_manifest "$backup_file"

decrypt_backup() {
  openssl enc -d -"$BACKUP_CIPHER" -pbkdf2 \
    -iter "$PBKDF2_ITERATIONS" -md sha256 \
    -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
    -in "$backup_file"
}

# Wrong keys and corrupt/non-PostgreSQL plaintext fail before application downtime.
decrypt_backup | \
  docker compose --env-file "$ENV_FILE" exec -T postgres pg_restore --list >/dev/null

restore_started=false
restore_failure() {
  local exit_code=$?
  if [[ $restore_started == true ]]; then
    printf 'ERROR: Restore failed; web and worker remain stopped for investigation.\n' >&2
  fi
  exit "$exit_code"
}
trap restore_failure ERR

docker compose --env-file "$ENV_FILE" stop web worker
restore_started=true
decrypt_backup | \
  docker compose --env-file "$ENV_FILE" exec -T postgres \
    pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --clean \
    --if-exists \
    --no-owner \
    --no-acl \
    --exit-on-error \
    --single-transaction

docker compose --env-file "$ENV_FILE" run --rm migrate
docker compose --env-file "$ENV_FILE" up -d web worker
restore_started=false
trap - ERR
printf 'Restore completed. Verify readiness, metrics, and critical user journeys now.\n'
