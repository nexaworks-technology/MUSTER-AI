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

  it("M9 replaced the M6 'no promises item': with no promises on file the item says so", () => {
    expect(assembleHandoff(full()).items.find((i) => i.key === "promises_made")).toMatchObject({
      found: false,
      text: "Promises made by Sales: Not found in CRM",
    });
  });
});

describe("Sales handoff — promises and call-derived goals (M9, Q-64)", () => {
  const promise = (over: Partial<NonNullable<HandoffInput["promises"]>[number]> = {}) => ({
    id: "p1",
    what: "Native Zendesk integration",
    party: "UNCLEAR" as const,
    status: "OPEN" as const,
    dueDate: null,
    quote: "Sales promised a native Zendesk integration by the end of their first quarter.",
    sourceType: "NOTE",
    sourceId: "n1",
    ...over,
  });

  it("lists the promises Sales made, each with the promise and the quoted source record", () => {
    const h = byKey(assembleHandoff({ ...full(), promises: [promise()] }).items);
    expect(h.get("promises_made")).toMatchObject({ found: true, text: "1 promise made", values: ["Native Zendesk integration"] });
    expect(h.get("promises_made")!.sources).toEqual([
      { sourceType: "Promise", sourceId: "p1", label: "Native Zendesk integration" },
      { sourceType: "Note", sourceId: "n1", label: "Sales promised a native Zendesk integration by the end of their first quarter." },
    ]);
  });

  it("shows a due date and a late status in the value, never invents one", () => {
    const h = byKey(
      assembleHandoff({
        ...full(),
        promises: [promise({ party: "US", status: "LATE", dueDate: "2026-10-24", sourceType: "CALL_TRANSCRIPT", sourceId: "t1" }), promise({ id: "p2", what: "Other", dueDate: null })],
      }).items,
    );
    expect(h.get("promises_made")!.values).toEqual(["Native Zendesk integration (due Oct 24, 2026, late)", "Other"]);
  });

  it("a customer's promise is not Sales's, and a kept one is not an open handoff item", () => {
    const h = byKey(assembleHandoff({ ...full(), promises: [promise({ party: "CUSTOMER" }), promise({ id: "p3", status: "KEPT" })] }).items);
    expect(h.get("promises_made")).toMatchObject({ found: false, text: "Promises made by Sales: Not found in CRM", sources: [] });
  });

  it("no promises at all says 'Not found in CRM', also when the input has none", () => {
    for (const promises of [[], undefined])
      expect(byKey(assembleHandoff({ ...full(), ...(promises ? { promises } : {}) }).items).get("promises_made")).toMatchObject({ found: false, sources: [] });
  });

  it("a goal read from a call keeps its call and quote as sources", () => {
    const h = byKey(
      assembleHandoff({
        ...full(),
        goals: [{ id: "g9", text: "Cut month-end close to 3 days", sourceType: "CALL_TRANSCRIPT", sourceId: "t9", quote: "Our goal is to cut month-end close to 3 days.", origin: "AI" }],
      }).items,
    );
    expect(h.get("stated_goals")).toMatchObject({ found: true, values: ["Cut month-end close to 3 days (from a call)"] });
    expect(h.get("stated_goals")!.sources).toEqual([
      { sourceType: "Goal", sourceId: "g9", label: "Cut month-end close to 3 days" },
      { sourceType: "CallTranscript", sourceId: "t9", label: "Our goal is to cut month-end close to 3 days." },
    ]);
  });

  it("every found item still carries at least one source (none invented)", () => {
    for (const item of assembleHandoff({ ...full(), promises: [promise()] }).items.filter((i) => i.found))
      expect(item.sources.length, item.key).toBeGreaterThan(0);
  });
});

