import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * D-40: raw SQL must carry its own `"workspaceId" = ${…workspaceId}` filter. Fixtures are linted
 * as if they lived at a given path, because the permitted files are named in eslint.config.mjs.
 */
const eslint = new ESLint({ cwd: process.cwd(), ignore: false });
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "lint-fixtures", name), "utf8");

async function rawSqlErrors(name: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(fixture(name), { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "nexaworks/raw-sql-workspace")
    .map((m) => m.message);
}

const MODULE = "src/modules/health/service.ts";

describe("raw SQL must filter by workspace (D-40)", () => {
  it("flags raw SQL with no workspace filter", async () => {
    expect((await rawSqlErrors("raw-sql-unscoped.ts", MODULE)).join()).toMatch(/workspaceId/);
  });

  it("flags a workspaceId column compared with something that is not a workspace id", async () => {
    expect(await rawSqlErrors("raw-sql-wrong-variable.ts", MODULE)).toHaveLength(1);
  });

  it("refuses the unsafe raw methods", async () => {
    expect((await rawSqlErrors("raw-sql-unsafe.ts", MODULE)).join()).toMatch(/not allowed/);
  });

  it("refuses a prebuilt query it cannot check", async () => {
    expect((await rawSqlErrors("raw-sql-not-inline.ts", MODULE)).join()).toMatch(/inline/);
  });

  it("accepts tagged and Prisma.sql templates that filter by the workspace", async () => {
    expect(await rawSqlErrors("raw-sql-scoped.ts", MODULE)).toEqual([]);
  });

  it("applies to app code and the seed too", async () => {
    for (const p of ["src/app/(app)/health/page.tsx", "prisma/seed/run.ts", "scripts/x.ts"]) {
      expect(await rawSqlErrors("raw-sql-unscoped.ts", p)).toHaveLength(1);
    }
  });

  it("permits only the named files, and tests", async () => {
    for (const p of [
      "src/lib/db/scoped.ts",
      "src/lib/auth/invitations.ts",
      "src/lib/auth/identity.ts",
      "src/lib/jobs/outbox.ts",
      "src/modules/health/__tests__/x.test.ts",
      "e2e/support/db.ts",
    ]) {
      expect(await rawSqlErrors("raw-sql-unscoped.ts", p)).toEqual([]);
    }
    // A named file does not open its whole folder.
    expect(await rawSqlErrors("raw-sql-unscoped.ts", "src/lib/auth/session.ts")).toHaveLength(1);
    expect(await rawSqlErrors("raw-sql-unscoped.ts", "src/lib/jobs/queues.ts")).toHaveLength(1);
  });
});
