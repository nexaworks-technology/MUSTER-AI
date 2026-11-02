#!/bin/sh
# Documented fallback for machines without Docker (DECISIONS D-31): starts the Homebrew
# services and applies the same roles.sql as the compose init. Idempotent.
# Reads OWNER_DB_PASSWORD and APP_DB_PASSWORD from .env; never prints them.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "services-native: create .env from .env.example first" >&2; exit 1; }
set -a; . ./.env; set +a
: "${OWNER_DB_PASSWORD:?set OWNER_DB_PASSWORD in .env}"
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env}"

PG_SERVICE=$(brew services list | awk '/^postgresql@/ {print $1; exit}')
[ -n "$PG_SERVICE" ] || { echo "services-native: install PostgreSQL via Homebrew first" >&2; exit 1; }
brew services start "$PG_SERVICE" >/dev/null
brew services start redis >/dev/null
brew services start minio >/dev/null

until pg_isready -q; do sleep 1; done
psql -q -v ON_ERROR_STOP=1 -d postgres \
  -v owner_password="$OWNER_DB_PASSWORD" -v app_password="$APP_DB_PASSWORD" \
  -f docker/postgres/roles.sql >/dev/null
echo "services-native: $PG_SERVICE, redis and minio running; roles and databases ready"
