import { describe, expect, it } from "vitest";
import { judge, loadGolden } from "../golden";
import { getAgent } from "../registry";

/**
 * Golden replay (M4 §5, rule 6): every recorded fixture is judged by the same code the executor
 * runs, with no network. Adversarial cases must come out UNCITED / INVALID_OUTPUT / FAILED.
 */
for (const agent of ["health-analyst"]) {
  const cases = loadGolden(agent);
  describe(`${agent} golden fixtures`, () => {
    it("has the adversarial cases the founder asked for", () => {
      expect(cases.length).toBeGreaterThanOrEqual(8);
      expect(cases.some((c) => c.case === "healthy-no-claim")).toBe(true);
    });
    for (const c of cases)
      it(`${c.case}: ${c.description}`, () => {
        const v = judge(getAgent(c.agent), c.bundle, c.output, c.facts);
        expect({
          status: v.status,
          ...(c.expect.items !== undefined ? { items: v.items } : {}),
        }).toEqual(c.expect);
      });
  });
}
