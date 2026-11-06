import { describe, expect, it } from "vitest";
import { scanText } from "../secret-patterns";

/**
 * M12 A2 (test-first): the scanner the full-history scan relies on.
 * - A hard-coded fallback after `??` to a quoted literal naming a secret (the M10 survey shape) is a finding.
 * - A connection URL whose password part is a template interpolation (`${APP_PASS}@`) is code,
 *   not a credential — the same rule the db-password pattern already applies to `$` values.
 */
const join = (...parts: string[]) => parts.join("");

describe("secret patterns (M12)", () => {
  it("flags a hard-coded secret fallback after ??", () => {
    const line = join(
      "const SECRET = process.env.APP_SECRET ?? ",
      '"acme-',
      'signing-secret-key-2026";',
    );
    expect(scanText("src/x.ts", line)).toEqual([
      { file: "src/x.ts", line: 1, rule: "secret-fallback-default" },
    ]);
  });

  it("does not flag a fallback to another env var or a $-placeholder", () => {
    expect(scanText("src/x.ts", "const s = process.env.A_SECRET ?? process.env.B_SECRET;")).toEqual(
      [],
    );
    expect(scanText("src/x.ts", 'const s = process.env.A ?? "$REMOVED_SECRET";')).toEqual([]);
  });

  it("does not flag a URL whose password is a template interpolation", () => {
    const line = join("const U = `postgresql://${APP_USER}:", "${APP_PASS}@${PG_HOST}:5432/db`;");
    expect(scanText("scripts/x.ts", line)).toEqual([]);
  });

  it("still flags a URL with a literal password on a non-local host", () => {
    const line = join("postgres://app:", "s3cretPassw0rd", "@db.example.com:5432/x");
    expect(scanText("x.txt", line)).toEqual([{ file: "x.txt", line: 1, rule: "url-credentials" }]);
  });

  it("flags a hard-coded secret constant (the M8 unsubscribe fallback shape)", () => {
    const line = join("const UNSECURE_FALLBACK_", 'SECRET = "acme-', 'unsubscribe-secret-dev";');
    expect(scanText("src/x.ts", line)).toEqual([
      { file: "src/x.ts", line: 1, rule: "secret-constant-literal" },
    ]);
  });

  it("does not flag a secret constant read from env or a $-placeholder", () => {
    expect(scanText("src/x.ts", "const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;")).toEqual([]);
    expect(scanText("src/x.ts", 'const FALLBACK_SECRET = "$REMOVED";')).toEqual([]);
  });

  it("the secret-constant rule applies to shipped code, not to test fixtures", () => {
    const line = join("const SIGNING_", 'SECRET = "fixture-signing-', 'secret-1234";');
    expect(scanText("src/modules/x/__tests__/x.test.ts", line)).toEqual([]);
    expect(scanText("e2e/x.spec.ts", line)).toEqual([]);
    expect(scanText("src/modules/x/service.ts", line)).toHaveLength(1);
  });
});
