#!/bin/sh
# Runs once when the compose Postgres volume is first created.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v owner_password="$OWNER_DB_PASSWORD" -v app_password="$APP_DB_PASSWORD" \
  -f /opt/nexaworks/roles.sql
