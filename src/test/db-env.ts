/**
 * Points tests at the dedicated test database (ARCHITECTURE §10): same server and roles as dev,
 * database name suffixed `_test`. Refuses to run against anything else.
 */
import { existsSync } from "node:fs";

export function toTestDatabaseUrl(url: string): string {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  const testName = name.endsWith("_test") ? name : `${name.replace(/_dev$/, "")}_test`;
  u.pathname = `/${testName}`;
  return u.toString();
}

/**
 * Tests run one process per CPU, each with its own Prisma pool; the scoped client also runs reads
 * in parallel (M3 loaders). A small pool per process keeps the total under Postgres's
 * max_connections (100 here); queries queue for a connection instead of failing.
 */
export function withPoolLimit(url: string, limit = 5): string {
  const u = new URL(url);
  if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", String(limit));
  if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "30");
  return u.toString();
}

export function applyTestDatabaseEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const app = process.env.DATABASE_URL;
  const owner = process.env.DATABASE_URL_MIGRATE;
  if (!app || !owner)
    throw new Error("Tests need DATABASE_URL and DATABASE_URL_MIGRATE (see .env.example)");
  process.env.DATABASE_URL = withPoolLimit(toTestDatabaseUrl(app));
  process.env.DATABASE_URL_MIGRATE = toTestDatabaseUrl(owner);
  for (const v of [process.env.DATABASE_URL, process.env.DATABASE_URL_MIGRATE]) {
    if (!new URL(v).pathname.endsWith("_test"))
      throw new Error("Refusing to test against a non-_test database");
  }
  // Uploads in tests go to a separate bucket, never the dev one.
  if (process.env.S3_BUCKET && !process.env.S3_BUCKET.endsWith("-test"))
    process.env.S3_BUCKET = `${process.env.S3_BUCKET}-test`;
  Object.assign(process.env, { NODE_ENV: "test" });
}

/**
 * M12 B7 (D4, D-182): e2e has its OWN database, `<name>_e2e`, recreated from zero by Playwright's
 * global setup on every run, so e2e can never freeze or mutate state the vitest suites (on `_test`)
 * or a later e2e run depend on. Refuses to point anywhere else.
 */
export function toE2eDatabaseUrl(url: string): string {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  const e2eName = name.endsWith("_e2e") ? name : `${name.replace(/_(dev|test)$/, "")}_e2e`;
  u.pathname = `/${e2eName}`;
  return u.toString();
}

export function applyE2eDatabaseEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const app = process.env.DATABASE_URL;
  const owner = process.env.DATABASE_URL_MIGRATE;
  if (!app || !owner)
    throw new Error("e2e needs DATABASE_URL and DATABASE_URL_MIGRATE (see .env.example)");
  process.env.DATABASE_URL = withPoolLimit(toE2eDatabaseUrl(app));
  process.env.DATABASE_URL_MIGRATE = toE2eDatabaseUrl(owner);
  for (const v of [process.env.DATABASE_URL, process.env.DATABASE_URL_MIGRATE]) {
    if (!new URL(v).pathname.endsWith("_e2e"))
      throw new Error("Refusing to run e2e against a non-_e2e database");
  }
}
