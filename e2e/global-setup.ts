import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { E2E_QUEUE_PREFIX } from "../playwright.config";
import { applyE2eDatabaseEnv } from "../src/test/db-env";

/**
 * e2e runs against its own `<name>_e2e` database (M12 B7, D4, D-182), recreated from zero on every
 * run: drop + create through a Postgres superuser connection (the same path `pnpm services:native`
 * and the compose init use for roles), the per-database grants from docker/postgres/grants.sql,
 * `prisma migrate deploy`, then the seed with both tenants (SEED_DATA §2). Superuser connection:
 * `E2E_DB_ADMIN_URL` when set (CI), else the local socket's default superuser (Homebrew Postgres).
 */
export default async function globalSetup(): Promise<void> {
  applyE2eDatabaseEnv();
  const db = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!/^[a-z0-9_]+_e2e$/.test(db)) throw new Error(`refusing to recreate ${db}`);
  const admin = process.env.E2E_DB_ADMIN_URL ?? "postgres";
  const psql = (args: string[]) =>
    execFileSync("psql", ["-q", "-v", "ON_ERROR_STOP=1", ...args], { stdio: "pipe" });
  psql(["-d", admin, "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`]);
  psql(["-d", admin, "-c", `CREATE DATABASE ${db} OWNER nexaworks_owner`]);
  const adminOnE2e = admin.includes("://")
    ? (() => {
        const u = new URL(admin);
        u.pathname = `/${db}`;
        return u.toString();
      })()
    : db;
  psql(["-d", adminOnE2e, "-f", "docker/postgres/grants.sql"]);
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: process.env,
  });
  execFileSync("pnpm", ["exec", "tsx", "prisma/seed.ts", "--with-test-tenant"], {
    stdio: "pipe",
    env: process.env,
  });
  // Rate-limit windows outlive a run in Redis; each run starts with none (the database is new too).
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  try {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(
        cursor,
        "MATCH",
        `${E2E_QUEUE_PREFIX}:rl:*`,
        "COUNT",
        500,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
