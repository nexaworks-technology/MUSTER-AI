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

export function applyTestDatabaseEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const app = process.env.DATABASE_URL;
  const owner = process.env.DATABASE_URL_MIGRATE;
  if (!app || !owner)
    throw new Error("Tests need DATABASE_URL and DATABASE_URL_MIGRATE (see .env.example)");
  process.env.DATABASE_URL = toTestDatabaseUrl(app);
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
