#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${ENV_FILE:-"$PROJECT_DIR/.env.production"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi

cd "$PROJECT_DIR"
set -a
# The production environment file is root-owned and contains shell-safe KEY=VALUE pairs.
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -n "${RELEASE_SHA:-}" ]; then
  RELEASE_SHA=$(git rev-parse --verify "${RELEASE_SHA}^{commit}")
else
  RELEASE_SHA=$(git rev-parse --verify HEAD)
fi
export RELEASE_SHA

previous_image=$(docker compose --env-file "$ENV_FILE" images -q web 2>/dev/null || true)
if [ -n "$previous_image" ]; then
  docker tag "$previous_image" hardware:rollback
fi

echo "Building immutable release $RELEASE_SHA"
docker compose --env-file "$ENV_FILE" build migrate

echo "Starting PostgreSQL and applying forward-only migrations"
docker compose --env-file "$ENV_FILE" up -d postgres
docker compose --env-file "$ENV_FILE" run --rm migrate

echo "Starting application services"
docker compose --env-file "$ENV_FILE" up -d web worker caddy

attempt=0
until docker compose --env-file "$ENV_FILE" exec -T web \
  node -e "fetch('http://127.0.0.1:3000/api/health/ready',{headers:{authorization:'Bearer '+process.env.HEALTHCHECK_TOKEN}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 18 ]; then
    echo "Release failed private database/worker readiness." >&2
    echo "The prior image is retained as hardware:rollback." >&2
    exit 1
  fi
  sleep 5
done

health_url="https://${APP_DOMAIN}/api/health/live"
attempt=0
until curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 12 ]; then
    echo "Release failed its liveness check: $health_url" >&2
    echo "The prior image is retained as hardware:rollback." >&2
    exit 1
  fi
  sleep 5
done

docker compose --env-file "$ENV_FILE" ps
echo "Release $RELEASE_SHA is healthy."
