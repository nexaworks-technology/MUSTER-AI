import { describe, expect, it } from "vitest";
import { applyForbiddenNumeric } from "../validate";

/**
 * Agents never originate money or scores (ARCHITECTURE §1.3 6c, §3.3): any forbidden numeric
 * field an agent puts in a proposed action is overwritten from deterministic code, or removed
 * when code has no value for it.
 */
describe("forbidden-numeric overwrite", () => {
  const actions = [
    { type: "draftEmail", summary: "Check in", confidence: 0.99, amountMinor: 9_999_999 },
    { type: "createTask", summary: "Call", confidence: 0.2 },
  ];

  it("overwrites agent-supplied confidence and money with the deterministic values", () => {
    const out = applyForbiddenNumeric(actions, ["confidence", "amountMinor"], {
      confidence: 0.6,
      amountMinor: 142_000_00,
    });
    expect(out).toEqual([
      { type: "draftEmail", summary: "Check in", confidence: 0.6, amountMinor: 142_000_00 },
      { type: "createTask", summary: "Call", confidence: 0.6, amountMinor: 142_000_00 },
    ]);
  });

  it("removes a forbidden field when code has no value for it (never keeps the model's)", () => {
    const out = applyForbiddenNumeric(actions, ["confidence", "amountMinor"], {});
    expect(out).toEqual([
      { type: "draftEmail", summary: "Check in" },
      { type: "createTask", summary: "Call" },
    ]);
  });

  it("leaves fields that are not forbidden alone and does not mutate its input", () => {
    const out = applyForbiddenNumeric(actions, ["amountMinor"], {});
    expect(out[0]).toEqual({ type: "draftEmail", summary: "Check in", confidence: 0.99 });
    expect(actions[0]!.amountMinor).toBe(9_999_999);
  });
});
