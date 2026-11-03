import { describe, expect, it } from "vitest";
import { DEFAULT_STALL_PARAMS, detectStall, type OnboardingFacts } from "../stall";

/**
 * M6 §5 stall.test (D2, D4): one definition of "stalled", shared by the signal rules and the
 * nightly evaluate job. Blocker order (D2): our overdue steps, the customer's, no activity, key
 * feature unused, TTV past the cohort's P75; larger overdue days first within a class.
 */
const step = (
  id: string,
  over: Partial<OnboardingFacts["steps"][number]> = {},
): OnboardingFacts["steps"][number] => ({
  id,
  title: "A step",
  ownerSide: "US",
  dueDate: "2026-11-10",
  doneDate: null,
  blockedReason: null,
  ...over,
});

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  planId: "plan-1",
  startDate: "2026-09-30",
  asOf: "2026-11-02",
  valueReachedAt: null,
  steps: [],
  usage: [{ id: "u1", date: "2026-11-01", activeUsers: 3 }],
  featureUsage: [{ id: "f1", featureKey: "dashboards", date: "2026-10-20", users: 2 }],
  keyFeatures: [{ featureKey: "dashboards", label: "Dashboards" }],
  ttv: null,
  ...over,
});

describe("stall detection (D2, D4)", () => {
  it("a customer-side step overdue 12 days → stall, blocker 'SSO setup (customer) overdue 12 days'", () => {
    const r = detectStall(
      facts({
        steps: [step("s1", { title: "SSO setup", ownerSide: "CUSTOMER", dueDate: "2026-10-21" })],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.stalled).toBe(true);
    expect(r.blockers[0]).toMatchObject({
      kind: "STEP_OVERDUE_CUSTOMER",
      text: "SSO setup (customer) overdue 12 days",
      days: 12,
      sources: [{ sourceType: "OnboardingStep", sourceId: "s1", value: 12, date: "2026-10-21" }],
    });
    expect(r.reason).toBe("SSO setup (customer) overdue 12 days");
  });

  it("our overdue step ranks above the customer's, even when the customer's is older (D2)", () => {
    const r = detectStall(
      facts({
        steps: [
          step("c", { title: "SSO setup", ownerSide: "CUSTOMER", dueDate: "2026-10-21" }),
          step("u", { title: "Send admin guide", ownerSide: "US", dueDate: "2026-10-29" }),
        ],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.blockers.map((b) => b.kind)).toEqual(["STEP_OVERDUE_US", "STEP_OVERDUE_CUSTOMER"]);
    expect(r.reason).toBe("Send admin guide (us) overdue 4 days");
  });

  it("a blocked step carries its reason; done and not-yet-due steps never stall", () => {
    const r = detectStall(
      facts({
        steps: [
          step("b", {
            title: "Security review",
            ownerSide: "CUSTOMER",
            dueDate: "2026-10-25",
            blockedReason: "waiting on legal review",
          }),
          step("d", { title: "Kickoff", dueDate: "2026-10-01", doneDate: "2026-10-01" }),
          step("n", { title: "Training", dueDate: "2026-11-20" }),
        ],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.blockers.map((b) => b.text)).toEqual([
      "Security review (customer) overdue 8 days: waiting on legal review",
    ]);
  });

  it("a step overdue by less than the threshold is not a stall", () => {
    const r = detectStall(
      facts({ steps: [step("s", { dueDate: "2026-11-01" })] }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r).toMatchObject({ stalled: false, blockers: [] });
  });

  it("no logins for 9 days → stall from activity, with the last active day as the source", () => {
    const r = detectStall(
      facts({
        usage: [
          { id: "u0", date: "2026-10-24", activeUsers: 4 },
          { id: "u1", date: "2026-10-30", activeUsers: 0 },
        ],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.blockers[0]).toMatchObject({
      kind: "NO_ACTIVITY",
      text: "No one has used the product for 9 days",
      sources: [{ sourceType: "UsageDaily", sourceId: "u0", value: 4, date: "2026-10-24" }],
    });
  });

  it("a key feature never used by day 30 → stall naming the feature", () => {
    const r = detectStall(
      facts({
        keyFeatures: [
          { featureKey: "dashboards", label: "Dashboards" },
          { featureKey: "data_connectors", label: "Data connectors" },
        ],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.blockers).toEqual([
      expect.objectContaining({
        kind: "KEY_FEATURE_UNUSED",
        text: "Data connectors not used by day 33 (expected by day 30)",
      }),
    ]);
  });

  it("TTV past the cohort's P75 is a blocker, last in the order", () => {
    const r = detectStall(
      facts({
        steps: [step("c", { title: "SSO setup", ownerSide: "CUSTOMER", dueDate: "2026-10-21" })],
        ttv: {
          state: "NOT_REACHED",
          days: 33,
          verdict: "LATE",
          reason: "Day 33 and value not reached yet.",
          ownTargetDays: 60,
          cohort: {
            key: "tier=MID_TOUCH",
            label: "Mid-touch accounts",
            size: 6,
            medianDays: 21,
            p75Days: 25,
            fellBack: false,
          },
          sources: [{ sourceType: "OnboardingPlan", sourceId: "p-peer", value: 21, date: null }],
        },
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.blockers.map((b) => b.kind)).toEqual(["STEP_OVERDUE_CUSTOMER", "TTV_LATE"]);
  });

  it("no usage data at all → no stall from usage components, and a missing-data note (Rule 4)", () => {
    const r = detectStall(facts({ usage: null, featureUsage: null }), DEFAULT_STALL_PARAMS);
    expect(r.stalled).toBe(false);
    expect(r.missing).toEqual([
      "No product usage data for this account, so logins could not be checked.",
      "No feature usage data for this account, so key features could not be checked.",
    ]);
  });

  it("a plan whose value is reached is never stalled by usage or TTV", () => {
    const r = detectStall(
      facts({
        valueReachedAt: "2026-10-20",
        usage: [{ id: "u0", date: "2026-10-01", activeUsers: 1 }],
      }),
      DEFAULT_STALL_PARAMS,
    );
    expect(r.stalled).toBe(false);
  });
});
