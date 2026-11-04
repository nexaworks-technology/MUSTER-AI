import { describe, expect, it } from "vitest";
import { renderNarrative, validateNarrative, type NarrativeBlock } from "../placeholders";

/**
 * M7 B3 (M7.md §5): a document can only cite metrics the system computes. Numbers enter a
 * narrative only as {{metric.key}} placeholders; the renderer inserts the locked metric. A number
 * typed into the text, an unknown placeholder, or a malformed one is refused (never repaired).
 */
const KEYS = ["renewal.arr", "renewal.confidence", "renewal.date", "health.band"] as const;
const block = (text: string, type: NarrativeBlock["type"] = "paragraph"): NarrativeBlock => ({
  id: "b1",
  type,
  text,
});

describe("validateNarrative", () => {
  it("accepts prose whose numbers are all placeholders", () => {
    expect(
      validateNarrative(
        [
          block("The renewal on {{metric.renewal.date}} is at {{metric.renewal.confidence}}."),
          block("Confirm the renewal call", "bullet"),
        ],
        KEYS,
      ),
    ).toEqual([]);
  });

  it("refuses a free-text number that matches a locked metric, and says which placeholder to use", () => {
    const problems = validateNarrative([block("About 142,000 is at stake.")], KEYS, {
      "renewal.arr": "$142,000.00",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ blockId: "b1", kind: "NUMBER_IN_TEXT" });
    expect(problems[0]!.message).toContain("142,000");
    expect(problems[0]!.message).toContain("{{metric.renewal.arr}}");
  });

  it("refuses any other digits too: a number the system never computed is no more welcome", () => {
    for (const t of ["Renews in 41 days.", "Call by 2026-11-09.", "A 3-step plan.", "Q4 focus."])
      expect(validateNarrative([block(t)], KEYS).map((p) => p.kind)).toEqual(["NUMBER_IN_TEXT"]);
  });

  it("refuses an unknown placeholder", () => {
    const p = validateNarrative([block("Worth {{metric.renewal.bonus}}.")], KEYS);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "UNKNOWN_METRIC" });
    expect(p[0]!.message).toContain("renewal.bonus");
  });

  it("refuses malformed placeholders and other brace expressions", () => {
    for (const t of [
      "{{renewal.arr}}",
      "{{ metric.renewal.arr }}x{{",
      "{{metric.}}",
      "{{metric.renewal.arr",
      "{{name}}",
      "}} oops",
    ])
      expect(validateNarrative([block(t)], KEYS).map((p) => p.kind)).toContain("MALFORMED");
  });

  it("reports every problem across blocks, with its block id", () => {
    const p = validateNarrative(
      [
        { id: "a", type: "heading", text: "Plan for 90 days" },
        { id: "b", type: "paragraph", text: "{{metric.nope}}" },
      ],
      KEYS,
    );
    expect(p.map((x) => [x.blockId, x.kind])).toEqual([
      ["a", "NUMBER_IN_TEXT"],
      ["b", "UNKNOWN_METRIC"],
    ]);
  });

  it("a placeholder's own key may contain digits without being a number in the text", () => {
    expect(validateNarrative([block("See {{metric.q3.revenue}}.")], ["q3.revenue"])).toEqual([]);
  });
});

describe("renderNarrative", () => {
  it("inserts the locked metric text for each placeholder and leaves the prose alone", () => {
    const out = renderNarrative(
      [block("Renews {{metric.renewal.date}} with {{metric.renewal.confidence}} confidence.")],
      { "renewal.date": { text: "Dec 13, 2026" }, "renewal.confidence": { text: "70%" } },
    );
    expect(out[0]!.text).toBe("Renews Dec 13, 2026 with 70% confidence.");
  });

  it("renders a money metric as its restricted text when the viewer may not see it", () => {
    const out = renderNarrative([block("At stake: {{metric.renewal.arr}}.")], {
      "renewal.arr": { text: "Restricted" },
    });
    expect(out[0]!.text).toBe("At stake: Restricted.");
  });

  it("refuses to render a placeholder it has no metric for (never leaves braces or invents)", () => {
    expect(() => renderNarrative([block("{{metric.renewal.arr}}")], {})).toThrow(/renewal\.arr/);
  });
});
