import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Proves the import boundaries in eslint.config.mjs (acceptance M1 #7). Each fixture is linted
 * as if it lived at a given path, because the rule set depends on where the file sits.
 */
const eslint = new ESLint({ cwd: process.cwd(), ignore: false });
const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "lint-fixtures", name), "utf8");

async function restrictedImportErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

describe("import boundaries", () => {
  it("blocks the raw Prisma client in feature modules", async () => {
    const errors = await restrictedImportErrors(
      fixture("imports-raw-db.ts"),
      "src/modules/accounts/service.ts",
    );
    expect(errors.join()).toMatch(/scopedDb/);
  });

  it("allows the raw Prisma client inside src/lib/db and src/lib/auth", async () => {
    for (const p of ["src/lib/db/scoped.ts", "src/lib/auth/adapter.ts"]) {
      expect(await restrictedImportErrors(fixture("imports-raw-db.ts"), p)).toEqual([]);
    }
  });

  it("blocks the customer email transport everywhere except outbound dispatch", async () => {
    const code = fixture("imports-customer-transport.ts");
    for (const p of [
      "src/modules/plays/service.ts",
      "src/lib/db/scoped.ts",
      "src/app/(app)/page.tsx",
    ]) {
      expect((await restrictedImportErrors(code, p)).join()).toMatch(/dispatch\.ts/);
    }
    expect(await restrictedImportErrors(code, "src/modules/outbound/dispatch.ts")).toEqual([]);
  });

  it("blocks constructing PrismaClient outside src/lib/db", async () => {
    const errors = await restrictedImportErrors(
      fixture("constructs-prisma-client.ts"),
      "src/modules/accounts/service.ts",
    );
    expect(errors.join()).toMatch(/src\/lib\/db/);
  });

  it("blocks importing another module's internals", async () => {
    const errors = await restrictedImportErrors(
      `import { x } from "@/modules/accounts/rules/internal";\nexport const y = x;\n`,
      "src/modules/health/service.ts",
    );
    expect(errors.join()).toMatch(/service\.ts/);
  });
});
