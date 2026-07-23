#!/usr/bin/env sh
set -eu

umask 077
key_file=/run/secrets/backup.key
daily_dir=/backups/daily
weekly_dir=/backups/weekly
retention_days=${BACKUP_RETENTION_DAYS:-7}
retention_weeks=${BACKUP_RETENTION_WEEKS:-4}

validate_retention() {
  value=$1
  label=$2
  maximum=$3
  case "$value" in
    ""|*[!0-9]*|0[0-9]*)
      echo "$label must be a nonnegative base-10 integer without leading zeroes." >&2
      exit 1
      ;;
  esac
  if [ "${#value}" -gt "${#maximum}" ] || [ "$value" -gt "$maximum" ]; then
    echo "$label must not exceed $maximum." >&2
    exit 1
  fi
}

validate_retention "$retention_days" BACKUP_RETENTION_DAYS 3650
validate_retention "$retention_weeks" BACKUP_RETENTION_WEEKS 520

if [ ! -r "$key_file" ]; then
  echo "Backup encryption key is unavailable." >&2
  exit 1
fi

key_length=$(wc -c < "$key_file" | tr -d ' ')
if [ "$key_length" -lt 32 ]; then
  echo "Backup encryption key must contain at least 32 bytes." >&2
  exit 1
fi

mkdir -p "$daily_dir" "$weekly_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
plain=$(mktemp /tmp/hardware-backup.XXXXXX.dump)
verified=$(mktemp /tmp/hardware-backup-verify.XXXXXX.dump)
encrypted="$daily_dir/hardware-$timestamp.dump.enc"
staged="$daily_dir/.hardware-$timestamp.dump.enc.partial"
staged_manifest="$daily_dir/.hardware-$timestamp.dump.enc.sha256.partial"
trap 'rm -f "$plain" "$verified" "$staged" "$staged_manifest"' EXIT HUP INT TERM

export PGPASSWORD=$POSTGRES_PASSWORD
pg_dump \
  --host postgres \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --no-owner \
  --no-privileges \
  --file "$plain"

openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -salt \
  -in "$plain" \
  -out "$staged" \
  -pass "file:$key_file"

# Prove that the encrypted archive can be decrypted and listed before it is
# published as a successful backup.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
  -in "$staged" \
  -out "$verified" \
  -pass "file:$key_file"
pg_restore --list "$verified" >/dev/null

digest=$(sha256sum "$staged" | awk '{print $1}')
printf '%s  %s\n' "$digest" "$(basename "$encrypted")" > "$staged_manifest"
mv "$staged" "$encrypted"
mv "$staged_manifest" "$encrypted.sha256"

if [ "$(date -u +%u)" = "7" ]; then
  week=$(date -u +%G-W%V)
  weekly="$weekly_dir/hardware-$week.dump.enc"
  weekly_staged="$weekly.partial"
  cp "$encrypted" "$weekly_staged"
  mv "$weekly_staged" "$weekly"
  printf '%s  %s\n' "$digest" "$(basename "$weekly")" > "$weekly.sha256"
fi

find "$daily_dir" -mindepth 1 -maxdepth 1 -type f -name 'hardware-*.dump.enc' -mtime "+$retention_days" -delete
find "$daily_dir" -mindepth 1 -maxdepth 1 -type f -name 'hardware-*.dump.enc.sha256' -mtime "+$retention_days" -delete

weekly_count=$(find "$weekly_dir" -mindepth 1 -maxdepth 1 -type f -name 'hardware-*.dump.enc' | wc -l | tr -d ' ')
if [ "$weekly_count" -gt "$retention_weeks" ]; then
  remove_count=$((weekly_count - retention_weeks))
  find "$weekly_dir" -mindepth 1 -maxdepth 1 -type f -name 'hardware-*.dump.enc' -print \
    | sort \
    | head -n "$remove_count" \
    | while IFS= read -r old_backup; do
        rm -f -- "$old_backup" "$old_backup.sha256"
      done
fi

echo "Encrypted backup created: $(basename "$encrypted")"
