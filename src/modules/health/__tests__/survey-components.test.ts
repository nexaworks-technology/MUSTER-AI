import { describe, expect, it } from "vitest";
import { runComponent } from "../engine/components";
import type { AccountBundle } from "../engine/types";
import { DEFAULT_MODEL } from "../engine/model";

function makeBundle(overrides: Partial<AccountBundle> = {}): AccountBundle {
  return {
    accountId: "acc-1",
    asOf: "2026-11-02",
    tier: "HIGH_TOUCH",
    plan: "ENTERPRISE",
    employeeBand: "100-500",
    useCase: "B2B",
    usage: null,
    ownBaseline: null,
    cohort: null,
    userUsage: null,
    featureUsage: null,
    keyFeatures: [],
    contract: null,
    messages: null,
    workspaceHasTickets: false,
    tickets: [],
    contacts: [
      { id: "c-1", name: "Alice", status: "ACTIVE", statusDate: null },
      { id: "c-2", name: "Bob", status: "ACTIVE", statusDate: null },
    ],
    roles: [
      { id: "r-1", contactId: "c-1", role: "DECISION_MAKER", validFrom: "2026-01-01", validTo: null },
      { id: "r-2", contactId: "c-2", role: "CHAMPION", validFrom: "2026-01-01", validTo: null },
    ],
    invoices: [],
    revenueEvents: [],
    pulse: null,
    surveys: [],
    ...overrides,
  };
}

describe("survey_average component", () => {
  it("returns MISSING_DATA when there are no survey responses", () => {
    const b = makeBundle({ surveys: [] });
    const r = runComponent("SENTIMENT", "survey_average", b, DEFAULT_MODEL);
    expect(r.score).toBeNull();
    expect(r.reason.kind).toBe("MISSING_DATA");
    expect(r.reason.message).toContain("No survey responses yet");
  });

  it("scores normalized survey responses correctly with source attribution", () => {
    const b = makeBundle({
      surveys: [
        {
          id: "sr-1",
          surveyId: "s-1",
          type: "NPS",
          score: 4, // 4/10 -> 40
          contactId: "c-1",
          date: "2026-10-25",
        },
      ],
    });
    const r = runComponent("SENTIMENT", "survey_average", b, DEFAULT_MODEL);
    expect(r.score).toBe(40);
    expect(r.reason.kind).toBe("EVIDENCE");
    expect(r.reason.sources).toEqual([{ sourceType: "SurveyResponse", sourceId: "sr-1" }]);
  });
});

describe("nps_decision_makers component", () => {
  it("returns MISSING_DATA when decision maker has not responded to NPS", () => {
    const b = makeBundle({ surveys: [] });
    const r = runComponent("RELATIONSHIP", "nps_decision_makers", b, DEFAULT_MODEL);
    expect(r.score).toBeNull();
    expect(r.reason.kind).toBe("MISSING_DATA");
  });

  it("scores decision maker NPS response with source attribution", () => {
    const b = makeBundle({
      surveys: [
        {
          id: "sr-1",
          surveyId: "s-1",
          type: "NPS",
          score: 4, // 4/10 -> 40
          contactId: "c-1", // c-1 is DECISION_MAKER
          date: "2026-10-25",
        },
        {
          id: "sr-2",
          surveyId: "s-1",
          type: "NPS",
          score: 10,
          contactId: "c-2", // c-2 is CHAMPION, not DECISION_MAKER
          date: "2026-10-25",
        },
      ],
    });
    const r = runComponent("RELATIONSHIP", "nps_decision_makers", b, DEFAULT_MODEL);
    expect(r.score).toBe(40);
    expect(r.reason.kind).toBe("EVIDENCE");
    expect(r.reason.sources).toEqual([{ sourceType: "SurveyResponse", sourceId: "sr-1" }]);
  });
});
