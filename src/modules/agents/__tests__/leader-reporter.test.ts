import { describe, expect, it } from "vitest";
import { evaluateOutput } from "../evaluate";
import { figureSourceId, leaderReporter } from "../definitions/leader-reporter";
import type { ContextBundle, ContextRecord } from "../schemas";

/**
 * The Leader Reporter's numbers rule (D-75, D-164): a figure or a date in the digest must appear in a
 * record the same output cites; a citation to a record it was not given is refused; nothing refused
 * is ever rendered (UNCITED / INVALID_OUTPUT render nothing).
 */
const SNAP = "snap_health";
const header: ContextRecord = {
  sourceType: "ReportSnapshot",
  sourceId: SNAP,
  fields: {
    report: "portfolio-health-trend",
    periodStart: "2026-10-26",
    periodEnd: "2026-11-01",
    accountsInScope: 12,
  },
};
const atRisk: ContextRecord = {
  sourceType: "ReportSnapshot",
  sourceId: figureSourceId(SNAP, 0, 0),
  fields: {
    report: "portfolio-health-trend",
    section: "Now",
    label: "At Risk now",
    value: 3,
    unit: "count",
    reason: null,
  },
};
const noValue: ContextRecord = {
  sourceType: "ReportSnapshot",
  sourceId: figureSourceId(SNAP, 0, 1),
  fields: {
    report: "portfolio-health-trend",
    section: "Now",
    label: "Median days to renew",
    value: null,
    unit: "days",
    reason: "No renewals closed in the period",
  },
};
const bundle: ContextBundle = [header, atRisk, noValue];
const ref = (r: { sourceType: string; sourceId: string }) => ({
  sourceType: r.sourceType,
  sourceId: r.sourceId,
});

const answer = (text: string, cites = [atRisk]) => ({
  reasoningSummary: "Leads with the accounts at risk.",
  confidence: 0.7,
  citations: cites.map(ref),
  proposedActions: [],
  items: [{ text, citations: cites.map(ref) }],
});

describe("leader-reporter evaluation", () => {
  it("accepts a figure that is in the cited record", () => {
    const r = evaluateOutput(leaderReporter, bundle, answer("At Risk now is 3."));
    expect(r.status).toBe("SUCCEEDED");
  });

  it("accepts a period date when the cited report record states it (D-164)", () => {
    const r = evaluateOutput(
      leaderReporter,
      bundle,
      answer("For 2026-10-26 to 2026-11-01, At Risk now is 3.", [header, atRisk]),
    );
    expect(r.status).toBe("SUCCEEDED");
  });

  it("refuses a number that is in no cited figure: UNCITED, nothing to render", () => {
    const r = evaluateOutput(leaderReporter, bundle, answer("At Risk now is 4."));
    expect(r).toMatchObject({ status: "UNCITED" });
    expect((r as { problems: string[] }).problems.join()).toContain('"4"');
  });

  it("refuses a number that is only in a record the output does not cite", () => {
    // 12 is in the header record, which this output does not cite.
    const r = evaluateOutput(leaderReporter, bundle, answer("12 accounts are in scope."));
    expect(r.status).toBe("UNCITED");
  });

  it("refuses a date that is not in a cited figure (D-164)", () => {
    const r = evaluateOutput(
      leaderReporter,
      bundle,
      answer("At Risk now is 3 as of 2026-11-09.", [atRisk]),
    );
    expect(r.status).toBe("UNCITED");
    expect((r as { problems: string[] }).problems.join()).toMatch(/"(2026|11|09)"/);
  });

  it("refuses a citation to a figure the run was not given (e.g. a money figure left out)", () => {
    const money = { sourceType: "ReportSnapshot", sourceId: figureSourceId(SNAP, 1, 0) };
    const r = evaluateOutput(leaderReporter, bundle, {
      ...answer("At Risk now is 3."),
      items: [{ text: "At Risk now is 3.", citations: [ref(atRisk), money] }],
    });
    expect(r.status).toBe("UNCITED");
    expect((r as { problems: string[] }).problems.join()).toContain("which the run was not given");
  });

  it("an item with no citation is invalid output", () => {
    const r = evaluateOutput(leaderReporter, bundle, {
      ...answer("At Risk now is 3."),
      items: [{ text: "At Risk now is 3.", citations: [] }],
    });
    expect(r.status).toBe("INVALID_OUTPUT");
  });

  it("says plainly that a figure is missing, using the cited reason", () => {
    const r = evaluateOutput(
      leaderReporter,
      bundle,
      answer("There is no figure for Median days to renew: No renewals closed in the period.", [
        noValue,
      ]),
    );
    expect(r.status).toBe("SUCCEEDED");
  });
});
