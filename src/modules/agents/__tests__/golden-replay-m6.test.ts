import { describe, expect, it } from "vitest";
import { judge, loadGolden } from "../golden";
import { getAgent } from "../registry";

/**
 * Golden replay for the two M6 agents (M6 §5, M4 rule 6): every recorded fixture is judged by the
 * same code the executor runs, with no network. Adversarial cases must come out UNCITED,
 * INVALID_OUTPUT or FAILED. (A separate file from the M4 replay so that file stays untouched.)
 */
const MIN_CASES: Record<string, number> = { "onboarding-manager": 8, "adoption-coach": 6 };

for (const agent of ["onboarding-manager", "adoption-coach"]) {
  const cases = loadGolden(agent);
  describe(`${agent} golden fixtures`, () => {
    it("has the adversarial cases and the 'nothing to say' case", () => {
      expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES[agent]!);
      expect(
        cases.some((c) => ["nothing-to-say", "all-used-nothing-to-say"].includes(c.case)),
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
