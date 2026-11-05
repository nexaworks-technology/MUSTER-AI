/**
 * Milestone 10 fresh-database demo (M10.md §7). Creates a brand-new scratch database from the
 * database URLs already in the environment (no credential appears in this file), migrates it,
 * seeds the demo workspace with M10 demo data, runs the 4 scenarios in a child process pointed at it,
 * and drops it again.
 *
 *   pnpm exec tsx --env-file=.env scripts/demo-m10.ts [--keep]
 */
import { execFileSync, spawnSync } from "node:child_process";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (use --env-file=.env)`);
  return new URL(v);
};
const app = need("DATABASE_URL");
const owner = need("DATABASE_URL_MIGRATE");
const SCRATCH = `nexaworks_scratch_m10_${Date.now()}`;
const withDb = (u: URL, db: string) => {
  const c = new URL(u.toString());
  c.pathname = `/${db}`;
  c.search = "";
  return c.toString();
};

/** psql with the password in PGPASSWORD, never on the command line. */
function psql(db: string, sql: string) {
  execFileSync(
    "psql",
    [
      "-h",
      owner.hostname,
      "-p",
      owner.port || "5432",
      "-U",
      decodeURIComponent(owner.username),
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-c",
      sql,
    ],
    {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(owner.password) },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

const env = {
  ...process.env,
  DATABASE_URL: withDb(app, SCRATCH),
  DATABASE_URL_MIGRATE: withDb(owner, SCRATCH),
  ALLOW_FAKE_CLOCK: "true",
  APP_FAKE_NOW: "2026-11-02T17:00:00Z",
  NODE_ENV: "development" as const,
};
const appRole = decodeURIComponent(app.username);
const ownerRole = decodeURIComponent(owner.username);

function main() {
  console.log(`[setup] scratch database ${SCRATCH}`);
  psql("postgres", `CREATE DATABASE ${SCRATCH} OWNER ${ownerRole};`);
  psql(
    SCRATCH,
    `GRANT ALL ON SCHEMA public TO ${appRole}; ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT ALL ON TABLES TO ${appRole}; ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA public GRANT ALL ON SEQUENCES TO ${appRole};`,
  );
  try {
    console.log("[setup] migrating");
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    psql(
      SCRATCH,
      `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${appRole}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`,
    );
    console.log("[setup] seeding the demo workspace (including M10 demo data)");
    execFileSync("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const r = spawnSync("pnpm", ["exec", "tsx", "scripts/demo-m10-run.ts"], {
      env,
      stdio: "inherit",
    });
    if (r.status !== 0) process.exitCode = r.status ?? 1;
  } finally {
    if (process.argv.includes("--keep")) console.log(`[cleanup] kept ${SCRATCH}`);
    else {
      psql("postgres", `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE);`);
      console.log(`[cleanup] dropped ${SCRATCH}`);
    }
  }
}

main();
