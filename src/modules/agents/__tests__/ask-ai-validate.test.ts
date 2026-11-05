import { describe, expect, it } from "vitest";
import { askAi } from "../definitions/ask-ai";
import { evaluateOutput } from "../evaluate";
import type { ContextBundle } from "../schemas";

/**
 * M11 S10 (test-first; M11.md "answer-validate"): an Ask AI answer is judged by the same evaluator
 * as every agent (Rules 1, 4; D-75; D-164 numbers rule unchanged). Not rendered when: no citation;
 * a citation to a record no tool returned; a number (dates included) that is in no cited record; a
 * figure pointing at a record that was not retrieved.
 */
const bundle: ContextBundle = [
  {
    sourceType: "Contract",
    sourceId: "c1",
    fields: { accountId: "a1", value: "142000.00", valueCurrency: "USD", renewal: "2026-12-15", noticePeriodDays: 60 },
  },
  {
    sourceType: "Extraction",
    sourceId: "x1",
    fields: { accountName: "Brightwell Logistics", quote: "Our CFO asked us to look at Tallyfield before renewal." },
  },
];
const base = { reasoningSummary: "Read the contract.", confidence: 0.8, proposedActions: [] };
const run = (raw: Record<string, unknown>) => evaluateOutput(askAi, bundle, { ...base, ...raw });

describe("Ask AI answer validation", () => {
  it("an answer with no citation is not rendered", () => {
    expect(run({ answer: "It is fine.", citations: [] }).status).toBe("INVALID_OUTPUT");
  });

  it("a number present in a cited record is accepted (formatting may differ)", () => {
    const r = run({
      answer: "Northgate's contract is worth $142,000 with a 60-day notice period.",
      citations: [{ sourceType: "Contract", sourceId: "c1" }],
      figures: [{ value: "142000.00", sourceType: "Contract", sourceId: "c1", field: "value" }],
    });
    expect(r.status).toBe("SUCCEEDED");
  });

  it("a number absent from every cited record is rejected (UNCITED)", () => {
    const r = run({
      answer: "The contract is worth $150,000.",
      citations: [{ sourceType: "Contract", sourceId: "c1" }],
    });
    expect(r.status).toBe("UNCITED");
  });

  it("a number that is only in a record the answer does not cite is rejected", () => {
    const r = run({
      answer: "It renews with 60 days' notice.",
      citations: [{ sourceType: "Extraction", sourceId: "x1" }],
    });
    expect(r.status).toBe("UNCITED");
  });

  it("a date in a cited record passes; a date in no cited record is refused (D-164)", () => {
    expect(
      run({ answer: "It renews on 2026-12-15.", citations: [{ sourceType: "Contract", sourceId: "c1" }] }).status,
    ).toBe("SUCCEEDED");
    expect(
      run({ answer: "It renews on 2027-01-31.", citations: [{ sourceType: "Contract", sourceId: "c1" }] }).status,
    ).toBe("UNCITED");
  });

  it("a citation to a record no tool returned is rejected", () => {
    const r = run({
      answer: "Tallyfield was mentioned.",
      citations: [{ sourceType: "Extraction", sourceId: "x-invented" }],
    });
    expect(r.status).toBe("UNCITED");
  });

  it("a quote must be verbatim from the cited record", () => {
    expect(
      run({
        answer: "Brightwell is looking at Tallyfield.",
        citations: [{ sourceType: "Extraction", sourceId: "x1", quote: "look at Tallyfield before renewal" }],
      }).status,
    ).toBe("SUCCEEDED");
    expect(
      run({
        answer: "Brightwell is leaving for Tallyfield.",
        citations: [{ sourceType: "Extraction", sourceId: "x1", quote: "we are leaving for Tallyfield" }],
      }).status,
    ).toBe("UNCITED");
  });

  it("a figure pointing at a record that was not retrieved is rejected", () => {
    const r = run({
      answer: "Worth $142,000.",
      citations: [{ sourceType: "Contract", sourceId: "c1" }],
      figures: [{ value: "142000.00", sourceType: "Contract", sourceId: "c-other", field: "value" }],
    });
    expect(r.status).toBe("UNCITED");
  });

  it("numbers in a proposed outreach draft are checked like the answer", () => {
    const r = run({
      answer: "I drafted a check-in.",
      citations: [{ sourceType: "Contract", sourceId: "c1" }],
      outreach: { accountId: "a1", contactId: "p1", subject: "Renewal", body: "Your renewal is 90 days away." },
    });
    expect(r.status).toBe("UNCITED");
  });
});
