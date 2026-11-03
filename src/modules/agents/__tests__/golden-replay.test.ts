import { describe, expect, it } from "vitest";
import { judge, loadGolden } from "../golden";
import { getAgent } from "../registry";

/**
 * Golden replay (M4 §5, rule 6): every recorded fixture is judged by the same code the executor
 * runs, with no network. Adversarial cases must come out UNCITED / INVALID_OUTPUT / FAILED.
 */
const MIN_CASES: Record<string, number> = { "health-analyst": 8, outreach: 5 };

for (const agent of ["health-analyst", "outreach"]) {
  const cases = loadGolden(agent);
  describe(`${agent} golden fixtures`, () => {
    it("has the adversarial cases the founder asked for", () => {
      expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES[agent]!);
      expect(
        cases.some(
          (c) => c.case === (agent === "outreach" ? "nothing-to-say" : "healthy-no-claim"),
        ),
      ).toBe(true);
      expect(
        cases.filter((c) => c.description.startsWith("ADVERSARIAL")).length,
      ).toBeGreaterThanOrEqual(3);
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
