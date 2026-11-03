import { describe, expect, it } from "vitest";
import { assembleHandoff, type HandoffInput } from "../handoff";

/**
 * M6 §5 handoff.test (Rules 1, 4; M6 rule 6): every item carries sources; a missing CRM field is
 * an honest "Not found in CRM" item, never an invented one. Promises wait for M9 and are not an
 * item type in M6.
 */
const full = (): HandoffInput => ({
  showMoney: true,
  contract: {
    id: "c1",
    startDate: "2026-09-30",
    valueMinor: 2_800_000n,
    currency: "USD",
    seatsPurchased: 15,
    renewalDate: "2027-09-30",
    crm: { source: "HubSpot", objectType: "deal", externalId: "d-77" },
  },
  roles: [
    {
      id: "r1",
      role: "CHAMPION",
      contactId: "k1",
      contactName: "Mei Chen",
      title: "Clinical Ops Lead",
    },
    {
      id: "r2",
      role: "DECISION_MAKER",
      contactId: "k2",
      contactName: "Dr. Ana Ruiz",
      title: "COO",
    },
  ],
  goals: [
    {
      id: "g1",
      text: "Cut weekly reporting time in half",
      sourceType: "Contract",
      sourceId: "c1",
      quote: null,
    },
  ],
  risks: [
    {
      id: "s1",
      title: "Onboarding stalled: SSO setup (customer) overdue 12 days",
      severity: "WARN",
    },
  ],
  kickoffNote: null,
});

const byKey = (items: ReturnType<typeof assembleHandoff>["items"]) =>
  new Map(items.map((i) => [i.key, i]));

describe("Sales handoff (M6 rule 6)", () => {
  it("lists contract, key people, goals and risks, each with its sources", () => {
    const h = byKey(assembleHandoff(full()).items);
    expect(h.get("contract_start")).toMatchObject({
      found: true,
      text: "Contract starts Sep 30, 2026",
    });
    expect(h.get("contract_value")).toMatchObject({ found: true, text: "$28,000.00 a year" });
    expect(h.get("contract_value")!.sources).toEqual([
      { sourceType: "Contract", sourceId: "c1", label: "Contract (from HubSpot deal d-77)" },
    ]);
    expect(h.get("champion")).toMatchObject({ found: true, text: "Mei Chen, Clinical Ops Lead" });
    expect(h.get("champion")!.sources).toEqual([
      { sourceType: "StakeholderRole", sourceId: "r1", label: "Champion role" },
      { sourceType: "Contact", sourceId: "k1", label: "Mei Chen" },
    ]);
    expect(h.get("stated_goals")).toMatchObject({
      found: true,
      values: ["Cut weekly reporting time in half"],
    });
    expect(h.get("open_risks")!.values).toEqual([
      "Onboarding stalled: SSO setup (customer) overdue 12 days",
    ]);
    for (const item of assembleHandoff(full()).items.filter((i) => i.found))
      expect(item.sources.length).toBeGreaterThan(0);
  });

  it("a missing CRM field is 'Not found in CRM', never invented", () => {
    const h = byKey(
      assembleHandoff({
        ...full(),
        contract: null,
        roles: [],
        goals: [],
        risks: [],
        kickoffNote: null,
      }).items,
    );
    for (const key of [
      "contract_start",
      "contract_value",
      "seats_bought",
      "renewal_date",
      "champion",
      "decision_maker",
      "exec_sponsor",
      "billing_contact",
      "stated_goals",
      "kickoff_notes",
    ])
      expect(h.get(key), key).toMatchObject({ found: false, sources: [] });
    expect(h.get("kickoff_notes")!.text).toBe("Kickoff call notes: Not found in CRM");
    expect(h.get("champion")!.text).toBe("Champion: Not found in CRM");
    expect(h.get("open_risks")).toMatchObject({ found: true, text: "No open risks", values: [] });
  });

  it("a contract field that is empty is not found, even when the contract exists", () => {
    const h = byKey(
      assembleHandoff({
        ...full(),
        contract: { ...full().contract!, valueMinor: null, renewalDate: null },
      }).items,
    );
    expect(h.get("contract_value")).toMatchObject({
      found: false,
      text: "Contract value: Not found in CRM",
    });
    expect(h.get("renewal_date")).toMatchObject({
      found: false,
      text: "Renewal date: Not found in CRM",
    });
    expect(h.get("contract_start")!.found).toBe(true);
  });

  it("money is hidden without revenue access (field-level protection)", () => {
    const h = byKey(assembleHandoff({ ...full(), showMoney: false }).items);
    expect(h.get("contract_value")).toMatchObject({
      found: true,
      text: "Contract value on file (revenue access needed to see it)",
    });
  });

  it("has no promises item in M6 (Promise tracking starts in M9)", () => {
    expect(assembleHandoff(full()).items.some((i) => i.key.includes("promise"))).toBe(false);
  });
});
