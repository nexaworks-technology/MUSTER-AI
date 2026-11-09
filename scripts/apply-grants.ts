/**
 * scripts/apply-grants.ts
 *
 * Re-applies runtime-role grants (docker/postgres/grants.sql) to app_user using
 * the database owner/superuser credentials (DATABASE_URL_MIGRATE).
 * Mandatory after `prisma migrate deploy` or `migrate reset` to ensure app_user
 * maintains row read/write permissions while nexaworks_owner owns schema DDL.
 */
import { applyDatabaseGrants } from "../src/lib/db/grants";

async function main() {
  await applyDatabaseGrants();
  console.log("[apply-grants] Successfully applied grants to app_user.");
}

main().catch((err) => {
  console.error("[apply-grants] Failed to apply grants:", err);
  process.exit(1);
});
