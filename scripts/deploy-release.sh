#!/usr/bin/env bash
# scripts/deploy-release.sh
#
# Production release and migration runner (SF-4 / NTH-2).
# Wires database migration deployment, SQL role grant reconciliation,
# and pre-flight healthcheck probe into a single automated release command.

set -euo pipefail

echo "=========================================================="
echo "  Production Deployment & Release Runner  "
echo "=========================================================="
echo "Release timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# 1. Ensure required database URLs exist
if [ -z "${DATABASE_URL_MIGRATE:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "[-] ERROR: Neither DATABASE_URL_MIGRATE nor DATABASE_URL is set in environment."
  exit 1
fi

# 2. Run Prisma migrations deploy
echo ""
echo "[+] Step 1/3: Applying database migrations (prisma migrate deploy)..."
pnpm exec prisma migrate deploy

# 3. Apply schema grants to app_user (docker/postgres/grants.sql)
echo ""
echo "[+] Step 2/3: Reconciling runtime role grants (docker/postgres/grants.sql)..."
pnpm exec tsx scripts/apply-grants.ts

# 4. Run system healthcheck probe
echo ""
echo "[+] Step 3/3: Running pre-flight / post-migration healthcheck..."
pnpm exec tsx scripts/healthcheck.ts

echo ""
echo "[✓] Deployment & release migration completed successfully."
