import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgent, judge } from "@/modules/agents/service";
import { validateExtraction } from "../extraction";

/**
 * Golden extraction replay (M4 §5; ARCHITECTURE §5.4): recorded Watcher responses → the
 * Extraction rows that would be written, judged by the same code as a live run, with no network.
 * The fixtures live in prompts/__golden__/extraction/ (this test sits here because vitest runs
 * src/, scripts/ and prisma/ only).
 */
const DIR = path.join(process.cwd(), "prompts", "__golden__", "extraction");
interface Fixture {
  case: string;
  description: string;
  sourceType: string;
  sourceText: string;
  output: unknown;
  expect: {
    status: string;
    kinds?: string[];
    sentiment?: string | null;
    dropped?: number;
    flags?: string[][];
  };
}
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Fixture);

describe("extraction golden fixtures", () => {
  it("has at least 10, including the adversarial ones", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const c of [
      "question-not-promise",
      "question-mislabelled-as-promise",
      "invented-quote",
      "invented-promise-date",
    ])
      expect(fixtures.map((f) => f.case)).toContain(c);
  });

  for (const f of fixtures)
    it(`${f.case}: ${f.description}`, () => {
      const bundle = [
        {
          sourceType: f.sourceType,
          sourceId: "src",
          fields: { subject: null, text: f.sourceText },
        },
      ];
      const v = judge(getAgent("watcher"), bundle, f.output);
      expect(v.status).toBe(f.expect.status);
      if (v.status !== "SUCCEEDED") return;
      const r = validateExtraction(f.sourceText, f.output);
      expect(r.kept.map((k) => k.kind)).toEqual(f.expect.kinds);
      expect(r.sentiment?.label ?? null).toBe(f.expect.sentiment);
      expect(r.dropped).toHaveLength(f.expect.dropped!);
      if (f.expect.flags) expect(r.kept.map((k) => k.flags)).toEqual(f.expect.flags);
    });
});
