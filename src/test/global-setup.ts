import { execFileSync } from "node:child_process";
import { applyTestDatabaseEnv } from "./db-env";

/**
 * Brings the test database up to the latest migration once per `pnpm test` run.
 * Non-destructive by design: tests create uniquely named workspaces and assert only within
 * them, so rows left by earlier runs cannot affect results (and AuditLog is append-only anyway).
 */
export default function globalSetup(): void {
  applyTestDatabaseEnv();
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      stdio: "pipe",
      env: process.env,
    });
  } catch (error) {
    const out = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `prisma migrate deploy failed for the test database:\n${String(out.stderr ?? "")}${String(out.stdout ?? "")}`,
    );
  }
}
