import { execFileSync } from "node:child_process";
import { applyTestDatabaseEnv } from "../src/test/db-env";

/** e2e runs against the `_test` database: migrate it, then seed both tenants (SEED_DATA §2). */
export default function globalSetup(): void {
  applyTestDatabaseEnv();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: process.env,
  });
  execFileSync("pnpm", ["exec", "tsx", "prisma/seed.ts", "--with-test-tenant"], {
    stdio: "pipe",
    env: process.env,
  });
}
