import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgent, judge } from "@/modules/agents/service";
import { validateExtraction } from "../extraction";

/**
 * Per-kind golden replay (M9 §5, acceptance #4): prompts/__golden__/extraction/<KIND>/*.json, at
 * least 3 positive + 1 negative for every extraction kind, replayed through the same judge and
 * validator as a live run with no network. The flat M4 fixtures keep their own replay test.
 */
const ROOT = path.join(process.cwd(), "prompts", "__golden__", "extraction");
const KINDS = [
  "SENTIMENT",
  "COMPETITOR",
  "BUDGET_CONCERN",
  "PROMISE",
  "GOAL",
  "CANCEL_LANGUAGE",
  "EXPORT_LANGUAGE",
  "COMPLAINT",
  "RENEWAL_CONCERN",
  "ACTION_ITEM",
  "DECISION",
  "THEME",
  "INTENT",
] as const;

interface Fixture {
  case: string;
  kind: string;
  polarity: "positive" | "negative";
  sourceType: string;
  sourceText: string;
  output: { items: Array<{ kind: string; payload: Record<string, unknown> }> };
  expect: { status: string; kinds: string[]; quotes: string[]; sentiment: string | null; dropped: number };
}

const byKind = new Map<string, Fixture[]>();
for (const dir of readdirSync(ROOT).filter((d) => statSync(path.join(ROOT, d)).isDirectory()))
  byKind.set(
    dir,
    readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(ROOT, dir, f), "utf8")) as Fixture),
  );

describe("per-kind golden fixtures", () => {
  it("covers every extraction kind with at least 3 positive and 1 negative", () => {
    const counts = KINDS.map((k) => ({
      kind: k,
      positive: (byKind.get(k) ?? []).filter((f) => f.polarity === "positive").length,
      negative: (byKind.get(k) ?? []).filter((f) => f.polarity === "negative").length,
    }));
    for (const c of counts) {
      expect(c.positive, `${c.kind} positives`).toBeGreaterThanOrEqual(3);
      expect(c.negative, `${c.kind} negatives`).toBeGreaterThanOrEqual(1);
    }
  });

  for (const [kind, fixtures] of byKind)
    for (const f of fixtures)
      it(`${kind}/${f.case} (${f.polarity})`, () => {
        expect(f.kind).toBe(kind);
        const bundle = [{ sourceType: f.sourceType, sourceId: "src", fields: { subject: null, text: f.sourceText } }];
        const verdict = judge(getAgent("watcher"), bundle, f.output);
        expect(verdict.status).toBe(f.expect.status);
        const r = validateExtraction(f.sourceText, f.output);
        expect(r.kept.map((k) => k.kind)).toEqual(f.expect.kinds);
        expect([...r.kept.map((k) => k.quote), ...(r.sentiment ? [r.sentiment.quote] : [])]).toEqual(
          f.expect.quotes,
        );
        expect(r.sentiment?.label ?? null).toBe(f.expect.sentiment);
        expect(r.dropped).toHaveLength(f.expect.dropped);
        if (f.polarity === "negative") expect(r.kept).toHaveLength(0);
        for (const k of r.kept)
          if (k.kind === "PROMISE") {
            const proposed = f.output.items[k.itemIndex]!.payload.dueDate ?? null;
            expect(k.payload.dueDate ?? null).toBe(proposed);
            expect(k.flags.includes("no_date")).toBe(proposed === null);
          }
      });
});
