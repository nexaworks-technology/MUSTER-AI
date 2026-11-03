import { describe, expect, it } from "vitest";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { checkCitations, checkNumbers, normalizeWhitespace } from "../validate";

/**
 * The citation validator (M4 §5, Rules 1 and 4): an AI claim renders only when every source it
 * names was in its input, every quote is verbatim, and every number it writes is in a record it
 * cites — counts, money, dates and percentages alike (founder point 6).
 */
const bundle: ContextBundle = [
  {
    sourceType: "HealthReason",
    sourceId: "r1",
    fields: {
      message:
        "Typical weekday active users fell from 40 to 20.4 (−49%) against this account's normal (Jul 21 – Oct 19, 2026)",
    },
  },
  {
    sourceType: "HealthReason",
    sourceId: "r2",
    fields: { message: "Champion Maya Ortiz: email bounced (Oct 27, 2026)" },
  },
  {
    sourceType: "Signal",
    sourceId: "s1",
    fields: { title: "Only 36 of 207 seats in use", value: 36 },
  },
];

describe("citation ids and quotes", () => {
  it("passes when every cited id is in the bundle and quotes are verbatim", () => {
    expect(
      checkCitations(
        [{ sourceType: "HealthReason", sourceId: "r2", quote: "email bounced" }],
        bundle,
      ),
    ).toEqual([]);
  });

  it("a citation id not in the bundle → UNCITED", () => {
    expect(checkCitations([{ sourceType: "HealthReason", sourceId: "r9" }], bundle)).toEqual([
      "cites HealthReason r9, which the run was not given",
    ]);
  });

  it("a citation whose type does not match the record is not accepted", () => {
    expect(checkCitations([{ sourceType: "Signal", sourceId: "r1" }], bundle)).toHaveLength(1);
  });

  it("a quote that is not a verbatim substring → UNCITED", () => {
    expect(
      checkCitations(
        [{ sourceType: "HealthReason", sourceId: "r2", quote: "champion has left the company" }],
        bundle,
      ),
    ).toEqual(['quote "champion has left the company" is not in HealthReason r2']);
  });

  it("a whitespace-normalised match passes", () => {
    expect(
      checkCitations(
        [{ sourceType: "HealthReason", sourceId: "r2", quote: "Maya   Ortiz:\n email\tbounced" }],
        bundle,
      ),
    ).toEqual([]);
    expect(normalizeWhitespace("  a \n\t b ")).toBe("a b");
  });

  it("an empty citations array fails the schema", () => {
    const parsed = baseAgentOutput.safeParse({
      reasoningSummary: "r",
      confidence: 0.5,
      citations: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("numbers in narrative text", () => {
  const cited = bundle.slice(0, 2);
  it("passes when each number, date and percentage is in a cited record", () => {
    expect(
      checkNumbers(["Weekday users fell from 40 to 20.4, down 49% since Oct 19, 2026."], cited),
    ).toEqual([]);
  });

  it("an invented count fails", () => {
    expect(checkNumbers(["Usage fell for 3 weeks in a row."], cited)).toEqual([
      'the number "3" is not in any record it cites',
    ]);
  });

  it("an invented percentage fails even when nearby numbers are real", () => {
    expect(checkNumbers(["Users fell from 40 to 20.4 (−52%)."], cited)).toEqual([
      'the number "52" is not in any record it cites',
    ]);
  });

  it("an invented date fails", () => {
    expect(checkNumbers(["Maya's email bounced on Oct 29, 2026."], cited)).toEqual([
      'the number "29" is not in any record it cites',
    ]);
  });

  it("a number in an uncited record does not count", () => {
    expect(checkNumbers(["Only 207 seats were bought."], cited)).toHaveLength(1);
  });

  it("treats 1,650 and 1650, and 20.40 and 20.4, as the same number", () => {
    const rec: ContextBundle = [
      { sourceType: "X", sourceId: "x", fields: { a: "1,650 reasons", b: "20.40 users" } },
    ];
    expect(checkNumbers(["1650 reasons and 20.4 users"], rec)).toEqual([]);
  });
});
