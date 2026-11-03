import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M3 rule 1 / acceptance #7: no LLM produces, adjusts or smooths any health, risk or signal
 * number. Neither module (nor anything it imports from them) may reach the AI provider.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

// Any way of reaching the module: `from "…"` (import/export), a side-effect `import "…"`, a dynamic
// `import("…")` and `require("…")` (M4 rule 2, review N2).
const AI =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@\/lib\/ai(\/[^"']*)?|@anthropic-ai\/[^"']+|openai|[^"']*\/lib\/ai(\/[^"']*)?)["']/;

describe("health and signals use no AI", () => {
  for (const mod of ["health", "signals"])
    it(`src/modules/${mod} never imports the AI provider`, () => {
      const offenders = files(path.join(ROOT, mod)).filter((f) => AI.test(readFileSync(f, "utf8")));
      expect(offenders).toEqual([]);
      expect(files(path.join(ROOT, mod)).length).toBeGreaterThan(5);
    });

  it("the check itself catches an AI import", () => {
    expect(AI.test('import { complete } from "@/lib/ai";')).toBe(true);
    expect(AI.test('import Anthropic from "@anthropic-ai/sdk";')).toBe(true);
    expect(AI.test('import { scopedDb } from "@/lib/db/scoped";')).toBe(false);
    expect(AI.test('import "@/lib/ai";')).toBe(true);
    expect(AI.test('const ai = await import("@/lib/ai");')).toBe(true);
    expect(AI.test("const m = await import('../../lib/ai/anthropic');")).toBe(true);
    expect(AI.test('const ai = require("@/lib/ai");')).toBe(true);
    expect(AI.test('export { complete } from "@/lib/ai";')).toBe(true);
    expect(AI.test('import { aiText } from "@/lib/aide";')).toBe(false);
  });
});
