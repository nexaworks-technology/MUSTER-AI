import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rule 3 by construction (M4 §5): in product code, only src/modules/outbound/dispatch.ts reaches
 * the customer transport, and only the customer transport reaches the raw Resend call. Any way of
 * importing counts: static, side-effect, dynamic import() and require(). The ESLint restricted
 * import says the same; this test checks the files themselves.
 */
const SRC = path.resolve(import.meta.dirname, "../../..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : files(p);
    return /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
  });

const importsOf = (module: string) =>
  new RegExp(`(?:\\bfrom\\s+|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'][^"']*${module}["']`);

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

describe("customer email import graph", () => {
  const all = files(SRC);

  it("only outbound/dispatch.ts imports the customer transport", () => {
    const re = importsOf("lib/email/customerTransport");
    expect(all.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel)).toEqual([
      "modules/outbound/dispatch.ts",
    ]);
  });

  it("only the customer transport imports the raw Resend call", () => {
    const re = importsOf("(lib/email/|\\./)resendHttp");
    expect(all.filter((f) => re.test(readFileSync(f, "utf8"))).map(rel)).toEqual([
      "lib/email/customerTransport.ts",
    ]);
  });

  it("the check catches every import form", () => {
    const re = importsOf("lib/email/customerTransport");
    for (const code of [
      'import { customerTransport } from "@/lib/email/customerTransport";',
      'import "@/lib/email/customerTransport";',
      'await import("../../lib/email/customerTransport")',
      'require("@/lib/email/customerTransport")',
    ])
      expect(re.test(code)).toBe(true);
    expect(re.test('import { sendStaffEmail } from "@/lib/email";')).toBe(false);
  });
});
