import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { COMPONENTS, runComponent } from "../engine/components";
import type { AccountBundle } from "../engine/types";

/**
 * Golden fixtures for every component (M3 rule 1): known inputs → known score → known reason
 * with its sources. Each component also has a no-data case that returns null, never 0 (Rule 4).
 */
const ASOF = "2026-11-02";
const ago = (n: number) => addDays(ASOF, -n);

const bundle = (o: Partial<AccountBundle> = {}): AccountBundle => ({
  accountId: "a1",
  asOf: ASOF,
  tier: "MID_TOUCH",
  plan: "Growth",
  employeeBand: "51-200",
  useCase: null,
  usage: null,
  ownBaseline: null,
  cohort: null,
  userUsage: null,
  featureUsage: null,
  keyFeatures: [],
  contract: null,
  messages: null,
  workspaceHasTickets: true,
  tickets: [],
  contacts: [],
  roles: [],
  invoices: [],
  revenueEvents: [],
  pulse: null,
  ...o,
});

/** Daily usage rows from `from` days ago to yesterday. */
const usage = (from: number, users: (daysAgo: number) => number, seatsUsed?: number) =>
  Array.from({ length: from }, (_, i) => {
    const d = from - i;
    return { id: `u${d}`, date: ago(d), activeUsers: users(d), seatsUsed: seatsUsed ?? null };
  });

const run = (pillar: string, component: string, b: AccountBundle) =>
  runComponent(pillar as never, component, b);

describe("Adoption components", () => {
  // Last week: 17 users on weekdays, 5 on the weekend; normal median 41.
  const dropped = bundle({
    usage: usage(120, (d) => (d <= 7 ? (d === 1 || d === 2 ? 5 : 17) : 41)),
    ownBaseline: { median: 41, p25: 39, historyDays: 91, from: ago(104), to: ago(14) },
  });

  it("active users vs own normal: Brightwell-shaped drop", () => {
    const r = run("ADOPTION", "active_vs_own", dropped);
    expect(r.score).toBeCloseTo(28.62, 2);
    expect(r.reason).toMatchObject({
      kind: "EVIDENCE",
      input: "active_users_typical_weekday",
      value: 17,
      baseline: 41,
      delta: -24,
      periodStart: "2026-10-26",
      periodEnd: "2026-11-01",
      message:
        "Typical weekday active users fell from 41 to 17 (−59%) against this account's normal (Jul 21 – Oct 19, 2026).",
      sources: [
        { sourceType: "UsageDaily", accountId: "a1", from: "2026-10-26", to: "2026-11-01" },
        { sourceType: "UsageDaily", accountId: "a1", from: "2026-07-21", to: "2026-10-19" },
      ],
    });
  });

  it("active users vs own normal: steady usage scores 100", () => {
    const r = run("ADOPTION", "active_vs_own", {
      ...dropped,
      usage: usage(120, () => 41),
    });
    expect(r.score).toBe(100);
    expect(r.reason.message).toBe(
      "Typical weekday active users are at this account's normal (41 vs 41, Jul 21 – Oct 19, 2026).",
    );
  });

  it("active users vs own normal: no data cases are null, never 0", () => {
    expect(run("ADOPTION", "active_vs_own", bundle()).score).toBeNull();
    expect(run("ADOPTION", "active_vs_own", bundle()).reason).toMatchObject({
      kind: "MISSING_DATA",
      message: "No product usage data.",
    });
    const short = run("ADOPTION", "active_vs_own", {
      ...dropped,
      ownBaseline: { median: 30, p25: 20, historyDays: 20, from: ago(104), to: ago(14) },
    });
    expect(short.score).toBeNull();
    expect(short.reason.message).toBe(
      "Not enough usage history to know this account's normal (20 days; 28 needed).",
    );
    const stale = run("ADOPTION", "active_vs_own", {
      ...dropped,
      usage: dropped.usage!.filter((u) => u.date <= "2026-10-20"),
    });
    expect(stale.score).toBeNull();
    expect(stale.reason.message).toBe("Usage data stops on Oct 20, 2026.");
  });

  it("ignores usage rows after the as-of date (look-ahead guard)", () => {
    const leaked = {
      ...dropped,
      usage: [
        ...dropped.usage!,
        { id: "future", date: "2026-11-05", activeUsers: 500, seatsUsed: null },
      ],
    };
    expect(run("ADOPTION", "active_vs_own", leaked).score).toBeCloseTo(28.62, 2);
  });

  it("active rate vs cohort", () => {
    const r = run("ADOPTION", "active_rate_vs_cohort", {
      ...dropped,
      contract: { id: "k1", seatsPurchased: 50, startDate: ago(200), renewalDate: null },
      cohort: {
        key: "tier=MID_TOUCH|plan=Growth",
        label: "Mid-touch accounts on the Growth plan",
        size: 12,
        medianRate: 0.6,
      },
    });
    expect(r.score).toBeCloseTo(54.44, 2);
    expect(r.reason).toMatchObject({
      value: 0.34,
      cohortValue: 0.6,
      cohortKey: "tier=MID_TOUCH|plan=Growth",
      cohortSize: 12,
      message:
        "34% of 50 seats are active on a typical weekday, against 60% for 12 Mid-touch accounts on the Growth plan.",
      sources: [
        { sourceType: "UsageDaily", accountId: "a1", from: "2026-10-26", to: "2026-11-01" },
        { sourceType: "Contract", sourceId: "k1" },
      ],
    });
    const few = run("ADOPTION", "active_rate_vs_cohort", {
      ...dropped,
      contract: { id: "k1", seatsPurchased: 50, startDate: ago(200), renewalDate: null },
      cohort: { key: "tier=HIGH_TOUCH", label: "High-touch accounts", size: 3, medianRate: 0.4 },
    });
    expect(few.score).toBeNull();
    expect(few.reason.message).toBe("Too few similar accounts to compare with (3; 5 needed).");
    expect(run("ADOPTION", "active_rate_vs_cohort", dropped).reason.message).toBe(
      "No seat count on the contract.",
    );
  });

  const users = (names: Array<[string, string | null, (d: number) => number]>, from = 90) =>
    names.flatMap(([id, contact, events]) =>
      Array.from({ length: from }, (_, i) => from - i).map((d) => ({
        externalUserId: id,
        contactId: contact,
        name: contact ? contact.replace("c-", "") : null,
        date: ago(d),
        events: events(d),
      })),
    );

  it("seat use over the last 28 days", () => {
    const r = run("ADOPTION", "seat_use", {
      ...dropped,
      contract: { id: "k1", seatsPurchased: 15, startDate: ago(200), renewalDate: null },
      userUsage: users(
        Array.from({ length: 12 }, (_, i) => [
          `u${i}`,
          null,
          (d: number) => (i < 9 ? 3 : d > 40 ? 3 : 0),
        ]),
      ),
    });
    expect(r.score).toBe(80);
    expect(r.reason).toMatchObject({
      value: 0.6,
      message: "9 of 15 seats were used in the last 28 days (60%).",
      sources: [
        { sourceType: "UserUsageDaily", accountId: "a1", from: "2026-10-05", to: "2026-11-01" },
        { sourceType: "Contract", sourceId: "k1" },
      ],
    });
  });

  it("key features in use", () => {
    const r = run("ADOPTION", "key_features", {
      ...dropped,
      keyFeatures: [
        { featureKey: "dashboards", label: "Dashboards" },
        { featureKey: "scheduled_reports", label: "Scheduled reports" },
        { featureKey: "alerts", label: "Alerts" },
        { featureKey: "data_connectors", label: "Data connectors" },
      ],
      featureUsage: [
        { featureKey: "dashboards", date: ago(3), users: 9 },
        { featureKey: "alerts", date: ago(20), users: 2 },
        { featureKey: "scheduled_reports", date: ago(40), users: 4 },
      ],
    });
    expect(r.score).toBe(45);
    expect(r.reason.message).toBe(
      "2 of 4 key features in the Growth plan were used in the last 28 days. Not used: Scheduled reports, Data connectors.",
    );
    expect(r.reason.sources).toEqual([
      { sourceType: "FeatureUsageDaily", accountId: "a1", from: "2026-10-05", to: "2026-11-01" },
    ]);
    expect(run("ADOPTION", "key_features", { ...dropped, featureUsage: [] }).reason.message).toBe(
      "No feature usage data.",
    );
  });

  it("power users still active", () => {
    const r = run("ADOPTION", "power_users", {
      ...dropped,
      userUsage: users([
        ["maya", "c-Maya Ortiz", (d) => (d >= 40 ? 50 : 0)],
        ["raj", "c-Raj Patel", () => 40],
        ...Array.from(
          { length: 18 },
          (_, i) => [`x${i}`, null, () => 2] as [string, null, () => number],
        ),
      ]),
    });
    expect(r.score).toBe(40);
    expect(r.reason.message).toBe(
      "1 of 2 power users was active in the last 14 days. Quiet: Maya Ortiz.",
    );
    expect(r.reason.sources).toEqual([
      { sourceType: "UserUsageDaily", accountId: "a1", from: "2026-08-04", to: "2026-11-01" },
      { sourceType: "Contact", sourceId: "c-Maya Ortiz" },
    ]);
    expect(run("ADOPTION", "power_users", dropped).score).toBeNull();
  });
});

describe("Engagement components", () => {
  const msg = (
    id: string,
    conv: string,
    direction: "INBOUND" | "OUTBOUND",
    date: string,
    o: { channel?: "EMAIL" | "TICKET"; from?: string | null; bounce?: boolean } = {},
  ) => ({
    id,
    conversationId: conv,
    channel: o.channel ?? "EMAIL",
    direction,
    date,
    fromContactId: o.from ?? (direction === "INBOUND" ? "c1" : null),
    isBounce: o.bounce ?? false,
  });

  it("days since the customer last wrote back (bounces and tickets excluded)", () => {
    const r = run("ENGAGEMENT", "last_customer_reply", {
      ...bundle(),
      messages: [
        msg("m1", "c1", "OUTBOUND", "2026-10-01"),
        msg("m2", "c1", "INBOUND", "2026-10-03"),
        msg("m3", "c2", "OUTBOUND", "2026-10-20"),
        msg("m4", "c2", "INBOUND", "2026-10-27", { from: null, bounce: true }),
        msg("m5", "t1", "INBOUND", "2026-10-30", { channel: "TICKET" }),
      ],
    });
    expect(r.score).toBe(75);
    expect(r.reason).toMatchObject({
      value: 30,
      message: "The customer last wrote back 30 days ago (Oct 3, 2026).",
      sources: [{ sourceType: "Message", sourceId: "m2" }],
    });
  });

  it("no reply on record is evidence (score 0); no messages at all is no data", () => {
    const r = run("ENGAGEMENT", "last_customer_reply", {
      ...bundle(),
      messages: [
        msg("m1", "c1", "OUTBOUND", "2026-09-01"),
        msg("m2", "c2", "OUTBOUND", "2026-10-01"),
      ],
    });
    expect(r.score).toBe(0);
    expect(r.reason.message).toBe(
      "No reply from the customer on record (2 messages sent since Sep 1, 2026).",
    );
    expect(run("ENGAGEMENT", "last_customer_reply", bundle()).score).toBeNull();
  });

  it("meetings have no data source yet", () => {
    const r = run("ENGAGEMENT", "last_meeting", bundle());
    expect(r.score).toBeNull();
    expect(r.reason).toMatchObject({
      kind: "MISSING_DATA",
      message: "No meeting data connected yet.",
    });
  });

  it("email reply rate over the 90 days ending 14 days ago", () => {
    const r = run("ENGAGEMENT", "reply_rate", {
      ...bundle(),
      messages: [
        msg("o1", "c1", "OUTBOUND", "2026-08-01"),
        msg("i1", "c1", "INBOUND", "2026-08-05"),
        msg("o2", "c2", "OUTBOUND", "2026-08-20"),
        msg("o3", "c3", "OUTBOUND", "2026-09-01"),
        msg("i3", "c3", "INBOUND", "2026-09-30"), // 29 days later: too late to count
        msg("o4", "c4", "OUTBOUND", "2026-09-15"),
        msg("i4", "c4", "INBOUND", "2026-09-16"),
        msg("o5", "c5", "OUTBOUND", "2026-10-10"),
        msg("o6", "c6", "OUTBOUND", "2026-10-25"), // newer than 14 days: not judged yet
      ],
    });
    expect(r.score).toBe(75);
    expect(r.reason.message).toBe("2 of 5 emails we sent got a reply within 14 days (40%).");
    const few = run("ENGAGEMENT", "reply_rate", {
      ...bundle(),
      messages: [
        msg("o1", "c1", "OUTBOUND", "2026-09-01"),
        msg("o2", "c2", "OUTBOUND", "2026-09-02"),
      ],
    });
    expect(few.score).toBeNull();
    expect(few.reason.message).toBe("Too few emails sent to judge the reply rate (2; 3 needed).");
  });

  const champion = (validTo: string | null = null) => ({
    contacts: [{ id: "maya", name: "Maya Ortiz", status: "ACTIVE" as const, statusDate: null }],
    roles: [
      { id: "r1", contactId: "maya", role: "CHAMPION" as const, validFrom: "2025-01-01", validTo },
    ],
  });
  const fromMaya = (dates: string[]) =>
    dates.map((d, i) => msg(`mm${i}`, `cm${i}`, "INBOUND", d, { from: "maya" }));

  it("champion activity against their own rhythm (quiet after 3× cadence, at least 21 days)", () => {
    const quiet = run("ENGAGEMENT", "champion_activity", {
      ...bundle(champion()),
      messages: fromMaya(["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22", "2026-09-19"]),
    });
    expect(quiet.score).toBe(0);
    expect(quiet.reason.message).toBe(
      "Maya Ortiz last wrote 44 days ago; usually every 7 days (quiet after 21).",
    );
    expect(quiet.reason.sources).toEqual([
      { sourceType: "Message", sourceId: "mm4" },
      { sourceType: "StakeholderRole", sourceId: "r1" },
    ]);
    const mid = run("ENGAGEMENT", "champion_activity", {
      ...bundle(champion()),
      messages: fromMaya(["2026-09-01", "2026-09-08", "2026-09-15", "2026-10-02"]),
    });
    expect(mid.score).toBeCloseTo(20.95, 2); // 31 days: between the quiet limit and twice it
    const fresh = run("ENGAGEMENT", "champion_activity", {
      ...bundle(champion()),
      messages: fromMaya(["2026-10-14", "2026-10-21", "2026-10-28"]),
    });
    expect(fresh.score).toBe(100);
  });

  it("champion activity has no data without a champion or a rhythm", () => {
    expect(
      run("ENGAGEMENT", "champion_activity", { ...bundle(), messages: [] }).reason.message,
    ).toBe("No current champion.");
    expect(
      run("ENGAGEMENT", "champion_activity", {
        ...bundle(champion()),
        messages: fromMaya(["2026-10-01"]),
      }).reason.message,
    ).toBe("Not enough messages from Maya Ortiz to know their usual rhythm (1).");
  });
});

describe("Support components", () => {
  const ticket = (
    id: string,
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT",
    opened: string,
    closed: string | null = null,
    escalated: string | null = null,
  ) => ({
    id,
    subject: `Ticket ${id}`,
    priority,
    openedDate: opened,
    closedDate: closed,
    escalatedDate: escalated,
  });

  it("open high or urgent tickets", () => {
    const b = bundle({
      tickets: [
        ticket("t1", "HIGH", "2026-10-29", null, "2026-10-29"),
        ticket("t2", "URGENT", "2026-10-01", "2026-10-05"),
      ],
    });
    const r = run("SUPPORT", "open_high", b);
    expect(r.score).toBe(60);
    expect(r.reason).toMatchObject({
      message: "1 high or urgent ticket is open.",
      sources: [{ sourceType: "Ticket", sourceId: "t1" }],
    });
    const none = run("SUPPORT", "open_high", bundle());
    expect(none.score).toBe(100);
    expect(none.reason.sources).toEqual([
      { sourceType: "Ticket", accountId: "a1", from: "2026-08-05", to: "2026-11-02" },
    ]);
  });

  it("oldest open ticket against its target time", () => {
    const r = run(
      "SUPPORT",
      "oldest_open_vs_target",
      bundle({ tickets: [ticket("t9", "HIGH", ago(9))] }),
    );
    expect(r.score).toBeCloseTo(68, 6);
    expect(r.reason.message).toBe(
      'Oldest open ticket "Ticket t9" (high) has been open 9 days; the target is 5.',
    );
    expect(run("SUPPORT", "oldest_open_vs_target", bundle()).score).toBe(100);
  });

  it("escalations in the last 30 days, by escalation date", () => {
    const r = run(
      "SUPPORT",
      "escalations_30d",
      bundle({
        tickets: [
          ticket("t1", "HIGH", ago(4), null, ago(4)),
          ticket("t0", "HIGH", ago(60), ago(50), ago(59)),
        ],
      }),
    );
    expect(r.score).toBe(50);
    expect(r.reason.message).toBe("1 ticket was escalated in the last 30 days.");
  });

  it("a ticket opened after the as-of date does not count (look-ahead guard)", () => {
    expect(
      run("SUPPORT", "open_high", bundle({ tickets: [ticket("tf", "URGENT", "2026-11-05")] }))
        .score,
    ).toBe(100);
  });

  it("no ticket data in the workspace means no data; text-based components wait for analysis", () => {
    for (const c of ["open_high", "oldest_open_vs_target", "escalations_30d"])
      expect(run("SUPPORT", c, bundle({ workspaceHasTickets: false })).reason.message).toBe(
        "No support ticket data.",
      );
    expect(run("SUPPORT", "repeat_problem", bundle()).score).toBeNull();
    expect(run("SUPPORT", "ticket_sentiment", bundle()).score).toBeNull();
  });
});

describe("Relationship components", () => {
  const people = (
    o: { status?: "ACTIVE" | "BOUNCED" | "LEFT"; statusDate?: string | null } = {},
  ) => ({
    contacts: [
      {
        id: "maya",
        name: "Maya Ortiz",
        status: o.status ?? "ACTIVE",
        statusDate: o.statusDate ?? null,
      },
      { id: "ben", name: "Ben Okafor", status: "ACTIVE" as const, statusDate: null },
    ],
    roles: [
      {
        id: "r1",
        contactId: "maya",
        role: "CHAMPION" as const,
        validFrom: "2025-09-01",
        validTo: null,
      },
      {
        id: "r2",
        contactId: "ben",
        role: "DECISION_MAKER" as const,
        validFrom: "2026-10-03",
        validTo: null,
      },
    ],
  });

  it("champion present: bounced as of the date it happened, not before (D-56)", () => {
    const b = bundle(people({ status: "BOUNCED", statusDate: "2026-10-27" }));
    const r = run("RELATIONSHIP", "champion_present", b);
    expect(r.score).toBe(10);
    expect(r.reason).toMatchObject({
      message: "Champion Maya Ortiz: email bounced (Oct 27, 2026).",
      sources: [
        { sourceType: "StakeholderRole", sourceId: "r1" },
        { sourceType: "Contact", sourceId: "maya" },
      ],
    });
    const before = run("RELATIONSHIP", "champion_present", { ...b, asOf: "2026-10-20" });
    expect(before.score).toBe(100);
    expect(before.reason.message).toBe("Champion Maya Ortiz is active.");
  });

  it("champion who left, champion role that ended, and none ever on record", () => {
    expect(
      run(
        "RELATIONSHIP",
        "champion_present",
        bundle(people({ status: "LEFT", statusDate: "2026-10-01" })),
      ).score,
    ).toBe(0);
    const ended = bundle({
      contacts: [{ id: "ed", name: "Ed Morton", status: "ACTIVE", statusDate: null }],
      roles: [
        {
          id: "r9",
          contactId: "ed",
          role: "CHAMPION",
          validFrom: "2025-01-01",
          validTo: "2026-10-01",
        },
      ],
    });
    const r = run("RELATIONSHIP", "champion_present", ended);
    expect(r.score).toBe(0);
    expect(r.reason.message).toBe("No champion since Ed Morton's role ended (Oct 1, 2026).");
    const never = run("RELATIONSHIP", "champion_present", bundle());
    expect(never.score).toBeNull();
    expect(never.reason.message).toBe("No champion on record.");
  });

  it("a role that starts after the as-of date is not counted (look-ahead guard)", () => {
    const r = run("RELATIONSHIP", "decision_maker", { ...bundle(people()), asOf: "2026-10-01" });
    expect(r.score).toBeNull();
    expect(r.reason.message).toBe("No decision maker on record.");
  });

  it("decision maker known", () => {
    const r = run("RELATIONSHIP", "decision_maker", bundle(people()));
    expect(r.score).toBe(100);
    expect(r.reason.message).toBe("Decision maker Ben Okafor is on record.");
  });

  it("how many people we know, against the tier's expectation", () => {
    const r = run("RELATIONSHIP", "breadth", bundle(people()));
    expect(r.score).toBeCloseTo(66.67, 2);
    expect(r.reason.message).toBe(
      "2 people with a role are on record; we expect 3 for a Mid-touch account.",
    );
    expect(run("RELATIONSHIP", "breadth", bundle()).score).toBeNull();
  });

  it("champion change in the last 90 days", () => {
    expect(run("RELATIONSHIP", "champion_change_90d", bundle(people())).score).toBe(100);
    const replaced = bundle({
      contacts: [
        { id: "ed", name: "Ed Morton", status: "LEFT", statusDate: "2026-10-01" },
        { id: "ana", name: "Ana Lee", status: "ACTIVE", statusDate: null },
      ],
      roles: [
        {
          id: "r9",
          contactId: "ed",
          role: "CHAMPION",
          validFrom: "2025-01-01",
          validTo: "2026-10-01",
        },
        { id: "r10", contactId: "ana", role: "CHAMPION", validFrom: "2026-10-01", validTo: null },
      ],
    });
    const r = run("RELATIONSHIP", "champion_change_90d", replaced);
    expect(r.score).toBe(30);
    expect(r.reason.message).toBe("Champion changed from Ed Morton to Ana Lee (Oct 1, 2026).");
  });

  it("CSM Pulse counts while valid, and is never invented", () => {
    const pulse = {
      id: "p1",
      value: "WORRIED" as const,
      authorName: "Leo Marsh",
      comment: "New VP is skeptical",
      createdDate: "2026-10-30",
      expiresDate: "2026-11-29",
    };
    const r = run("RELATIONSHIP", "pulse", bundle({ pulse }));
    expect(r.score).toBe(20);
    expect(r.reason).toMatchObject({
      message: 'Leo Marsh\'s Pulse: Worried — "New VP is skeptical" (Oct 30, 2026).',
      sources: [{ sourceType: "CsmPulse", sourceId: "p1" }],
    });
    expect(run("RELATIONSHIP", "pulse", bundle({ pulse, asOf: "2026-11-29" })).score).toBeNull();
    expect(run("RELATIONSHIP", "pulse", bundle({ pulse, asOf: "2026-10-29" })).score).toBeNull();
    expect(run("RELATIONSHIP", "pulse", bundle()).reason.message).toBe("No current CSM Pulse.");
    expect(run("RELATIONSHIP", "nps_decision_makers", bundle()).score).toBeNull();
  });
});

describe("Commercial components", () => {
  const inv = (
    id: string,
    due: string,
    o: { paid?: string | null; failed?: string | null; issued?: string } = {},
  ) => ({
    id,
    number: `INV-${id}`,
    issuedDate: o.issued ?? addDays(due, -30),
    dueDate: due,
    paidDate: o.paid ?? null,
    failedDate: o.failed ?? null,
    isVoid: false,
  });

  it("failed or late invoices in the last 90 days", () => {
    const clean = run(
      "COMMERCIAL",
      "invoices_90d",
      bundle({ invoices: [inv("1", ago(40), { paid: ago(41) })] }),
    );
    expect(clean.score).toBe(100);
    expect(clean.reason.message).toBe("All invoices in the last 90 days were paid on time (1).");
    const recovered = run(
      "COMMERCIAL",
      "invoices_90d",
      bundle({ invoices: [inv("2", "2026-09-01", { paid: "2026-09-20" })] }),
    );
    expect(recovered.score).toBe(70);
    expect(recovered.reason.message).toBe("Invoice INV-2 was paid 19 days late (Sep 20, 2026).");
    const failed = run(
      "COMMERCIAL",
      "invoices_90d",
      bundle({ invoices: [inv("3", ago(5), { failed: "2026-10-30" })] }),
    );
    expect(failed.score).toBe(30);
    expect(failed.reason).toMatchObject({
      message: "Invoice INV-3 failed on Oct 30, 2026 and is unpaid.",
      sources: [{ sourceType: "Invoice", sourceId: "3" }],
    });
    const two = run(
      "COMMERCIAL",
      "invoices_90d",
      bundle({ invoices: [inv("3", ago(5), { failed: ago(3) }), inv("4", ago(12))] }),
    );
    expect(two.score).toBe(0);
    expect(two.reason.message).toBe(
      "2 invoices are unpaid: INV-3 failed on Oct 30, 2026; INV-4 is 12 days past due.",
    );
  });

  it("a payment made after the as-of date does not count yet (look-ahead guard)", () => {
    const r = run(
      "COMMERCIAL",
      "invoices_90d",
      bundle({ invoices: [inv("3", ago(5), { failed: ago(3), paid: "2026-11-10" })] }),
    );
    expect(r.score).toBe(30);
    expect(run("COMMERCIAL", "invoices_90d", bundle()).reason.message).toBe(
      "No invoices on record.",
    );
  });

  it("seat-use trend over 90 days", () => {
    const r = run(
      "COMMERCIAL",
      "seat_trend",
      bundle({
        usage: usage(120, () => 10).map((u) => ({ ...u, seatsUsed: u.date > ago(91) ? 30 : 40 })),
      }),
    );
    expect(r.score).toBeCloseTo(62.5, 6);
    expect(r.reason.message).toBe("Seats in use went from 40 to 30 over 90 days.");
    expect(
      run("COMMERCIAL", "seat_trend", bundle({ usage: usage(120, () => 10) })).score,
    ).toBeNull();
  });

  it("contraction in the last 12 months, sized against ARR before it", () => {
    const ev = (id: string, type: "NEW" | "CONTRACTION", delta: number, date: string) => ({
      id,
      type,
      deltaArrMinor: delta,
      effectiveDate: date,
    });
    const r = run(
      "COMMERCIAL",
      "contraction_12m",
      bundle({
        revenueEvents: [
          ev("e1", "NEW", 3_000_000, "2025-06-01"),
          ev("e2", "CONTRACTION", -600_000, "2026-06-01"),
        ],
      }),
    );
    expect(r.score).toBe(40);
    expect(r.reason).toMatchObject({
      message: "ARR contracted by 20% on Jun 1, 2026.",
      sources: [{ sourceType: "RevenueEvent", sourceId: "e2" }],
    });
    expect(
      run(
        "COMMERCIAL",
        "contraction_12m",
        bundle({ revenueEvents: [ev("e1", "NEW", 3_000_000, "2025-06-01")] }),
      ).score,
    ).toBe(100);
    const none = run("COMMERCIAL", "contraction_12m", bundle());
    expect(none.score).toBeNull();
    expect(none.reason.message).toBe("No contract on file.");
    expect(run("COMMERCIAL", "renewal_plan", bundle()).score).toBeNull();
  });
});

describe("Sentiment components", () => {
  it("have no data until text analysis and surveys exist", () => {
    for (const c of ["sentiment_share", "survey_average"]) {
      const r = run("SENTIMENT", c, bundle());
      expect(r.score).toBeNull();
      expect(r.reason.kind).toBe("MISSING_DATA");
    }
  });
});

describe("every component", () => {
  it("is covered by a fixture above and returns a well-formed reason", () => {
    for (const [pillar, comps] of Object.entries(COMPONENTS)) {
      for (const name of Object.keys(comps)) {
        const r = run(pillar, name, bundle());
        expect(r.reason.component).toBe(name);
        if (r.score === null) expect(r.reason.kind).toBe("MISSING_DATA");
        if (r.reason.kind === "EVIDENCE") expect(r.reason.sources.length).toBeGreaterThan(0);
      }
    }
  });
});
