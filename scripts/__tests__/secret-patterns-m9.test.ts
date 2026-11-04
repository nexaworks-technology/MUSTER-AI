import { describe, expect, it } from "vitest";
import { scanText } from "../secret-patterns";

/**
 * Q-78 secret scan: catches committed local DB passwords matching the shape in commit 712d626,
 * while allowing env-reading code.
 *
 * Fixture strings are assembled from parts so this test file never contains the forbidden shape itself.
 */
describe("secret scanner: local DB password shape (Q-78)", () => {
  it("flags local DB password assignments with string literals", () => {
    const fixture1 = ["const OWNER", 'PASS = "t3mp-5cr4tch-pw";'].join("_");
    const fixture2 = ["const APP", 'PASS = "not-the-real-q78-password";'].join("_");
    const fixture3 = ["const DB", 'PASSWORD = "supersecret";'].join("_");

    expect(scanText("scripts/demo-fresh-db.ts", fixture1)).toEqual([
      { file: "scripts/demo-fresh-db.ts", line: 1, rule: "db-password" },
    ]);
    expect(scanText("scripts/demo-fresh-db.ts", fixture2)).toEqual([
      { file: "scripts/demo-fresh-db.ts", line: 1, rule: "db-password" },
    ]);
    expect(scanText("src/db.ts", fixture3)).toEqual([
      { file: "src/db.ts", line: 1, rule: "db-password" },
    ]);
  });

  it("does not flag the env-reading code", () => {
    const envReadingCode = [
      'const ownerUrl = new URL(process.env.DATABASE_URL_MIGRATE ?? "");',
      'const appUrl = new URL(process.env.DATABASE_URL ?? "");',
      "const OWNER_USER = decodeURIComponent(ownerUrl.username);",
      "const OWNER_PASS = decodeURIComponent(ownerUrl.password);",
      "const APP_USER = decodeURIComponent(appUrl.username);",
      "const APP_PASS = decodeURIComponent(appUrl.password);",
    ].join("\n");

    expect(scanText("scripts/demo-fresh-db.ts", envReadingCode)).toEqual([]);
  });
});
