#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PBKDF2_ITERATIONS=600000
readonly BACKUP_CIPHER=aes-256-cbc

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-"$PROJECT_DIR/.env.production"}

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
  [[ $key_owner == "$(id -u)" ]] || fail "Backup encryption key must be owned by the backup service user."
  line_count=$(awk 'END { print NR }' "$key_file")
  first_line_length=$(awk 'NR == 1 { print length($0); exit }' "$key_file")
  [[ $line_count == 1 && $first_line_length -ge 32 ]] || fail "Backup encryption key must contain one line of at least 32 characters."
}

write_manifest() {
  local file=$1
  local manifest=$2
  local display_name=$3
  local hash
  hash=$(sha256sum -- "$file")
  hash=${hash%% *}
  printf '%s  %s\n' "$hash" "$display_name" >"$manifest"
}

[[ -f $ENV_FILE ]] || fail "Missing production environment file: $ENV_FILE"

cd "$PROJECT_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

require_command awk
require_command docker
require_command find
require_command openssl
require_command restic
require_command sha256sum
require_command stat

BACKUP_DIR=${BACKUP_DIR:-/var/backups/hardware}
BACKUP_ENCRYPTION_KEY_FILE=${BACKUP_ENCRYPTION_KEY_FILE:-}
daily_retention=${BACKUP_RETENTION_DAYS:-7}
weekly_retention=${BACKUP_RETENTION_WEEKS:-4}

[[ -n $BACKUP_ENCRYPTION_KEY_FILE ]] || fail "BACKUP_ENCRYPTION_KEY_FILE is required."
[[ -n ${RESTIC_REPOSITORY:-} && -n ${RESTIC_PASSWORD:-} ]] || fail "RESTIC_REPOSITORY and RESTIC_PASSWORD are required for the off-host copy."
[[ $BACKUP_DIR = /* ]] || fail "BACKUP_DIR must be an absolute path."
case "$BACKUP_DIR" in
  / | /var | /var/backups) fail "BACKUP_DIR is too broad: $BACKUP_DIR" ;;
esac
[[ $daily_retention =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_RETENTION_DAYS must be a positive integer."
[[ $weekly_retention =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_RETENTION_WEEKS must be a positive integer."
validate_key_file "$BACKUP_ENCRYPTION_KEY_FILE"

readonly weekly_days=$((weekly_retention * 7))
readonly daily_dir="$BACKUP_DIR/daily"
readonly weekly_dir="$BACKUP_DIR/weekly"
mkdir -p -- "$daily_dir" "$weekly_dir"

date_stamp=$(date -u +%F)
readonly date_stamp
readonly daily_file="$daily_dir/hardware-$date_stamp.dump.enc"
temp_cipher=$(mktemp "$daily_dir/.hardware-$date_stamp.XXXXXX.dump.enc")
temp_manifest=""
weekly_temp=""
weekly_manifest_temp=""

cleanup() {
  [[ -z $temp_cipher ]] || rm -f -- "$temp_cipher"
  [[ -z $temp_manifest ]] || rm -f -- "$temp_manifest"
  [[ -z $weekly_temp ]] || rm -f -- "$weekly_temp"
  [[ -z $weekly_manifest_temp ]] || rm -f -- "$weekly_manifest_temp"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose --env-file "$ENV_FILE" exec -T postgres \
  pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --compress 9 \
  --no-owner \
  --no-acl | \
  openssl enc -"$BACKUP_CIPHER" -salt -pbkdf2 \
    -iter "$PBKDF2_ITERATIONS" -md sha256 \
    -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
    -out "$temp_cipher"

[[ -s $temp_cipher ]] || fail "Encrypted database backup is empty."

# Validate both the encryption key and custom-format archive before persistence.
openssl enc -d -"$BACKUP_CIPHER" -pbkdf2 \
  -iter "$PBKDF2_ITERATIONS" -md sha256 \
  -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" \
  -in "$temp_cipher" | \
  docker compose --env-file "$ENV_FILE" exec -T postgres pg_restore --list >/dev/null

temp_manifest=$(mktemp "$daily_dir/.hardware-$date_stamp.XXXXXX.sha256")
write_manifest "$temp_cipher" "$temp_manifest" "$(basename -- "$daily_file")"
mv -f -- "$temp_cipher" "$daily_file"
temp_cipher=""
mv -f -- "$temp_manifest" "$daily_file.sha256"
temp_manifest=""

if [[ $(date -u +%u) == 7 ]]; then
  week_stamp=$(date -u +%G-W%V)
  readonly week_stamp
  readonly weekly_file="$weekly_dir/hardware-$week_stamp.dump.enc"
  weekly_temp=$(mktemp "$weekly_dir/.hardware-$week_stamp.XXXXXX.dump.enc")
  weekly_manifest_temp=$(mktemp "$weekly_dir/.hardware-$week_stamp.XXXXXX.sha256")
  cp -- "$daily_file" "$weekly_temp"
  write_manifest "$weekly_temp" "$weekly_manifest_temp" "$(basename -- "$weekly_file")"
  mv -f -- "$weekly_temp" "$weekly_file"
  weekly_temp=""
  mv -f -- "$weekly_manifest_temp" "$weekly_file.sha256"
  weekly_manifest_temp=""
fi

find "$daily_dir" -type f -name 'hardware-*.dump.enc' -mtime +"$daily_retention" -delete
find "$daily_dir" -type f -name 'hardware-*.dump.enc.sha256' -mtime +"$daily_retention" -delete
find "$weekly_dir" -type f -name 'hardware-*.dump.enc' -mtime +"$weekly_days" -delete
find "$weekly_dir" -type f -name 'hardware-*.dump.enc.sha256' -mtime +"$weekly_days" -delete

restic backup "$daily_file" "$daily_file.sha256" --tag hardware-postgres
restic forget --tag hardware-postgres \
  --keep-daily "$daily_retention" \
  --keep-weekly "$weekly_retention" \
  --prune

printf 'Encrypted backup completed: %s\n' "$daily_file"
