import { describe, expect, it } from "vitest";
import { validateExtraction } from "../extraction";

/**
 * Extraction validation (ARCHITECTURE §5.3, D-75): a label is kept only with a verbatim quote from
 * its source; an unverifiable quote is dropped and counted, never repaired. Each kind has its own
 * payload schema; a promise date that does not parse is stored as null with a "no_date" flag.
 */
const ticket =
  "Hi team,\n\nHow do I   export all our data before we cancel at the end of the term? We are also looking at Tallyfield.\n\nThanks, Grace";

describe("validateExtraction", () => {
  it("keeps items whose quote is verbatim (after whitespace normalisation)", () => {
    const r = validateExtraction(ticket, {
      items: [
        {
          kind: "CANCEL_LANGUAGE",
          quote: "before we cancel at the end of the term",
          payload: {},
          confidence: 0.9,
        },
        {
          kind: "EXPORT_LANGUAGE",
          quote: "How do I export all our data",
          payload: {},
          confidence: 0.9,
        },
        {
          kind: "COMPETITOR",
          quote: "looking at Tallyfield",
          payload: { competitorName: "Tallyfield" },
          confidence: 0.8,
        },
      ],
      sentiment: { label: "NEGATIVE", quote: "before we cancel" },
    });
    expect(r.kept.map((k) => k.kind)).toEqual(["CANCEL_LANGUAGE", "EXPORT_LANGUAGE", "COMPETITOR"]);
    expect(r.kept[2]!.payload).toEqual({ competitorName: "Tallyfield" });
    expect(r.sentiment).toEqual({ label: "NEGATIVE", quote: "before we cancel" });
    expect(r.dropped).toEqual([]);
  });

  it("drops an invented quote and counts it", () => {
    const r = validateExtraction(ticket, {
      items: [
        {
          kind: "COMPLAINT",
          quote: "your support is terrible",
          payload: { theme: "support" },
          confidence: 0.7,
        },
      ],
      sentiment: { label: "NEGATIVE", quote: "we are furious" },
    });
    expect(r.kept).toEqual([]);
    expect(r.sentiment).toBeNull();
    expect(r.dropped).toEqual([
      { index: 0, kind: "COMPLAINT", reason: "quote not found in the source text" },
      { index: -1, kind: "SENTIMENT", reason: "quote not found in the source text" },
    ]);
  });

  it("checks each kind's payload with its own schema", () => {
    const r = validateExtraction(ticket, {
      items: [
        { kind: "COMPETITOR", quote: "looking at Tallyfield", payload: {}, confidence: 0.8 },
        {
          kind: "INTENT",
          quote: "How do I",
          payload: { intent: "world_domination" },
          confidence: 0.5,
        },
        { kind: "INTENT", quote: "How do I", payload: { intent: "question" }, confidence: 0.5 },
      ],
    });
    expect(r.kept.map((k) => k.kind)).toEqual(["INTENT"]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      expect.stringContaining("competitorName"),
      expect.stringContaining("intent"),
    ]);
  });

  it("a PROMISE without a parseable date keeps a null date and a no_date flag; it never invents one", () => {
    const text = "I promise we will send the export fix soon. The SSO fix will ship on 2026-11-20.";
    const r = validateExtraction(text, {
      items: [
        {
          kind: "PROMISE",
          quote: "we will send the export fix soon",
          payload: { what: "export fix", dueDate: "next week" },
          confidence: 0.8,
        },
        {
          kind: "PROMISE",
          quote: "The SSO fix will ship on 2026-11-20",
          payload: { what: "SSO fix", dueDate: "2026-11-20" },
          confidence: 0.9,
        },
        {
          kind: "PROMISE",
          quote: "we will send the export fix soon",
          payload: { what: "export fix", dueDate: "2026-12-01" },
          confidence: 0.6,
        },
      ],
    });
    expect(r.kept.map((k) => [k.payload, k.flags])).toEqual([
      [{ what: "export fix", dueDate: null }, ["no_date"]],
      [{ what: "SSO fix", dueDate: "2026-11-20" }, []],
      // A date the quote does not mention is not the model's to add.
      [{ what: "export fix", dueDate: null }, ["no_date"]],
    ]);
  });

  it("a 'promise' that is really a question is not a promise", () => {
    const r = validateExtraction("Could you fix the export by Friday?", {
      items: [
        {
          kind: "PROMISE",
          quote: "Could you fix the export by Friday?",
          payload: { what: "export fix", dueDate: null },
          confidence: 0.6,
        },
      ],
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual([
      { index: 0, kind: "PROMISE", reason: "a question is not a promise" },
    ]);
  });

  it("an unknown kind or an empty quote is dropped", () => {
    const r = validateExtraction(ticket, {
      items: [
        { kind: "MOOD", quote: "Thanks", payload: {}, confidence: 0.5 },
        { kind: "THEME", quote: "  ", payload: { theme: "x" }, confidence: 0.5 },
      ],
    });
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(2);
  });
});
