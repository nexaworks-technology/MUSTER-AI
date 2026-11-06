/**
 * Where this process runs (M12 B7, D-182). NODE_ENV says how it was BUILT; APP_ENV says what the
 * deployment is FOR. Production builds keep every production refusal, except the end-to-end test
 * build, which needs the test seams (fake business clock, recorded AI, log-only email and Slack,
 * fixture integrations, no-op scanner) to run the production build against the seeded world.
 * That exception needs BOTH `APP_ENV=e2e` AND a database whose name ends in `_e2e` — a production
 * or staging deployment cannot meet it by setting one variable.
 */
type Source = Record<string, string | undefined>;

const E2E_DB = /_e2e$/;

function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

export function testSeamsAllowed(source: Source = process.env): boolean {
  if (source.NODE_ENV !== "production") return true;
  const db = databaseName(source.DATABASE_URL);
  return source.APP_ENV === "e2e" && db !== null && E2E_DB.test(db);
}

/** HSTS and upgrade-insecure-requests: real production-built deployments, not the localhost e2e. */
export function transportHardeningOn(source: Source = process.env): boolean {
  return source.NODE_ENV === "production" && source.APP_ENV !== "e2e";
}
