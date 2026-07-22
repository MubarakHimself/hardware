#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-"$PROJECT_DIR/.env.production"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi

if ! docker image inspect hardware:rollback >/dev/null 2>&1; then
  echo "No retained hardware:rollback image exists." >&2
  exit 1
fi

cd "$PROJECT_DIR"
export RELEASE_SHA=rollback
docker compose --env-file "$ENV_FILE" up -d --no-build web worker caddy
docker compose --env-file "$ENV_FILE" ps

echo "Application containers now use the retained rollback image."
echo "Database migrations are not reversed; releases must use backward-compatible migrations."
