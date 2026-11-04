import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateExtraction } from "@/modules/conversations/service";
import { evaluateRule, type SignalBundle } from "../rules";
import type { TextFact, TextKind } from "../rules/text";

/**
 * The text rules fed by the M4/M9 golden extractions (M9 §5): a recorded model answer goes through
 * the same quote verification as a live run, becomes text facts, and the rules decide. This ties
 * the extraction contract to the signals; the per-rule fire / not-fire fixtures live in
 * fixtures/<ruleKey>/ and are run by rules.test.ts.
 */
const GOLDEN = path.join(process.cwd(), "prompts", "__golden__", "extraction");
const ASOF = "2026-11-02";

function factsFrom(file: string, opts: { channel?: TextFact["channel"]; days?: number } = {}) {
  const f = JSON.parse(readFileSync(path.join(GOLDEN, file), "utf8")) as {
    sourceText: string;
    output: unknown;
  };
  const v = validateExtraction(f.sourceText, f.output);
  const base = {
    sourceType: "MESSAGE" as const,
    channel: opts.channel ?? "TICKET",
    conversationId: "c1",
    direction: "INBOUND" as const,
    competitor: null,
    intent: null,
    label: null,
    theme: null,
  };
  const date = new Date(`${ASOF}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (opts.days ?? 2));
  const day = date.toISOString().slice(0, 10);
  const items: TextFact[] = v.kept.map((k, i) => ({
    ...base,
    id: `e${i}`,
    kind: k.kind as TextKind,
    sourceId: `m${i}`,
    date: day,
    quote: k.quote,
    competitor: typeof k.payload.competitorName === "string" ? k.payload.competitorName : null,
    intent: typeof k.payload.intent === "string" ? k.payload.intent : null,
    theme: typeof k.payload.theme === "string" ? k.payload.theme : null,
  }));
  if (v.sentiment)
    items.push({
      ...base,
      id: "s",
      kind: "SENTIMENT",
      sourceId: "m-s",
      date: day,
      quote: v.sentiment.quote,
      label: v.sentiment.label,
    });
  return items;
}

const bundle = (text: TextFact[]) =>
  ({ accountId: "a1", asOf: ASOF, text, messages: [], contract: null }) as unknown as SignalBundle;

describe("text rules over golden extractions", () => {
  it("cancel-language fires on 'how do I export all our data before we cancel' (Quillmark), and export-language goes critical with it", () => {
    const b = bundle(factsFrom("quillmark-cancel-export.json"));
    const cancel = evaluateRule("cancel_language", b, {});
    expect(cancel).toHaveLength(1);
    expect(cancel[0]).toMatchObject({ severity: "CRITICAL" });
    expect(cancel[0]!.evidence[0]).toMatchObject({
      sourceType: "Message",
      value: "before we cancel at the end of the term",
    });
    const exp = evaluateRule("export_language", b, {});
    expect(exp[0]).toMatchObject({ severity: "CRITICAL" });
  });

  it("competitor and budget concern fire from one note, each with its own quote", () => {
    const b = bundle(factsFrom("competitor-and-budget.json"));
    expect(evaluateRule("competitor_mentioned", b, {})[0]!.title).toBe("Tallyfield mentioned");
    expect(evaluateRule("budget_concern", b, {})[0]!.evidence[0]).toMatchObject({
      value: "our budget for next year has been cut by a third",
    });
  });

  it("a paraphrased quote never reaches the rules: nothing fires from an invented extraction", () => {
    const b = bundle(factsFrom("invented-quote.json"));
    for (const key of [
      "cancel_language",
      "competitor_mentioned",
      "budget_concern",
      "renewal_concern",
    ] as const)
      expect(evaluateRule(key, b, {})).toEqual([]);
  });

  it("neutral text raises nothing", () => {
    const b = bundle(factsFrom("neutral-nothing.json"));
    for (const key of [
      "cancel_language",
      "export_language",
      "angry_sentiment",
      "complaint_repeated",
      "repeat_problem",
    ] as const)
      expect(evaluateRule(key, b, {})).toEqual([]);
  });

  it("every text signal's evidence carries a quote and a date (proof, not a score)", () => {
    const b = bundle(factsFrom("quillmark-cancel-export.json"));
    for (const key of ["cancel_language", "export_language"] as const)
      for (const c of evaluateRule(key, b, {}))
        for (const e of c.evidence) {
          expect(typeof e.value).toBe("string");
          expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
  });
});
