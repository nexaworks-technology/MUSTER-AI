import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { scoreAsOf, type ScoredAccount } from "../service";

/**
 * M3 rule 4 / D-56: scoring an account as of a date uses only what was true on that date.
 *
 * The fixture plants, AFTER the as-of date, one fact of every kind that would change the score if
 * it leaked: usage, a reply, tickets, an escalation of an older ticket, invoices and a failure
 * count, a contact's status change, role changes, an ARR expansion that would move the tier, a
 * Pulse, and the outcome itself (lifecycle LOST, churnedAt). Scoring as of the date must give the
 * identical result before and after the plants; scoring as of a later date must see them.
 */
const D = "2026-09-30";
const LATER = "2026-11-01";
const at = (date: string, hour = 14) => new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);

let db: ReturnType<typeof scopedDb>;
let ctx: { workspaceId: string };
let accountId: string;
let membershipId: string;
let before: ScoredAccount;
const id: Record<string, string> = {};

beforeAll(async () => {
  const { actor } = await createTestAdmin("ScoreAsOf");
  ctx = { workspaceId: actor.workspaceId };
  membershipId = actor.membershipId;
  db = scopedDb(actor);
  const ws = actor.workspaceId;
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Leaky",
        tier: "MID_TOUCH",
        plan: "Growth",
        employeeBand: "51-200",
      },
    })
  ).id;
  const a = { workspaceId: ws, accountId };

  // ── History up to D ──────────────────────────────────────────────────────
  await db.usageDaily.createMany({
    data: Array.from({ length: 130 }, (_, i) => ({
      ...a,
      date: utcMidnight(addDays(D, -130 + i)),
      activeUsers: 20,
      sessions: 0,
      events: 0,
      seatsUsed: 20,
    })),
  });
  id.contract = (
    await db.contract.create({
      data: {
        ...a,
        startDate: utcMidnight("2025-10-01"),
        renewalDate: utcMidnight("2026-10-31"),
        seatsPurchased: 30,
        valueMinor: 2_000_000n,
      },
    })
  ).id;
  await db.revenueEvent.create({
    data: {
      ...a,
      type: "NEW",
      deltaArrMinor: 2_000_000n,
      currency: "USD",
      effectiveDate: utcMidnight("2025-10-01"),
      sourceType: "Contract",
      sourceId: id.contract,
    },
  });
  id.cara = (await db.contact.create({ data: { ...a, name: "Cara Champion" } })).id;
  id.dan = (await db.contact.create({ data: { ...a, name: "Dan Decider" } })).id;
  id.caraRole = (
    await db.stakeholderRole.create({
      data: { ...a, contactId: id.cara, role: "CHAMPION", validFrom: at("2025-10-01") },
    })
  ).id;
  id.danRole = (
    await db.stakeholderRole.create({
      data: { ...a, contactId: id.dan, role: "DECISION_MAKER", validFrom: at("2025-10-01") },
    })
  ).id;
  const conv = await db.conversation.create({
    data: { ...a, channel: "EMAIL", startedAt: at("2026-08-01"), lastMessageAt: at("2026-09-20") },
  });
  id.conv = conv.id;
  for (const [day, dir] of [
    ["2026-08-01", "OUTBOUND"],
    ["2026-08-03", "INBOUND"],
    ["2026-08-20", "OUTBOUND"],
    ["2026-08-22", "INBOUND"],
    ["2026-09-10", "OUTBOUND"],
    ["2026-09-20", "INBOUND"],
  ] as const)
    await db.message.create({
      data: {
        ...a,
        conversationId: conv.id,
        direction: dir,
        sentAt: at(day),
        bodyText: "x",
        fromContactId: dir === "INBOUND" ? id.cara : null,
      },
    });
  id.inv1 = (
    await db.invoice.create({
      data: {
        ...a,
        number: "INV-1",
        amountMinor: 100n,
        issuedAt: utcMidnight("2026-08-01"),
        dueAt: utcMidnight("2026-08-31"),
        paidAt: at("2026-08-30"),
        status: "PAID",
      },
    })
  ).id;
  id.oldTicket = (
    await db.ticket.create({
      data: { ...a, subject: "Old open ticket", priority: "NORMAL", openedAt: at("2026-09-25") },
    })
  ).id;

  before = (await scoreAsOf(ctx, [accountId], D)).get(accountId)!;

  // ── Plants after D: each would change the score if it leaked ─────────────
  await db.usageDaily.deleteMany({ where: { accountId, date: { gt: utcMidnight(D) } } });
  await db.usageDaily.createMany({
    data: Array.from({ length: 31 }, (_, i) => ({
      ...a,
      date: utcMidnight(addDays(D, i + 1)),
      activeUsers: 0,
      sessions: 0,
      events: 0,
      seatsUsed: 2,
    })),
  });
  await db.message.create({
    data: {
      ...a,
      conversationId: id.conv,
      direction: "INBOUND",
      sentAt: at("2026-10-01", 1),
      bodyText: "late reply",
      fromContactId: id.cara,
    },
  });
  await db.ticket.create({
    data: {
      ...a,
      subject: "After D",
      priority: "URGENT",
      openedAt: at("2026-10-03"),
      isEscalated: true,
      escalatedAt: at("2026-10-03"),
    },
  });
  await db.ticket.update({
    where: { id: id.oldTicket },
    data: { isEscalated: true, escalatedAt: at("2026-10-04"), priority: "URGENT" },
  });
  await db.invoice.create({
    data: {
      ...a,
      number: "INV-2",
      amountMinor: 100n,
      issuedAt: utcMidnight("2026-10-01"),
      dueAt: utcMidnight("2026-10-02"),
      lastFailedAt: at("2026-10-05"),
      failureCount: 3,
      status: "FAILED",
    },
  });
  await db.invoice.update({ where: { id: id.inv1 }, data: { failureCount: 5 } });
  await db.contact.update({
    where: { id: id.cara },
    data: { status: "LEFT", statusChangedAt: at("2026-10-10") },
  });
  await db.stakeholderRole.update({
    where: { id: id.danRole },
    data: { validTo: at("2026-10-01") },
  });
  await db.stakeholderRole.create({
    data: { ...a, contactId: id.dan, role: "EXEC_SPONSOR", validFrom: at("2026-10-02") },
  });
  await db.revenueEvent.create({
    data: {
      ...a,
      type: "EXPANSION",
      deltaArrMinor: 5_000_000n,
      currency: "USD",
      effectiveDate: utcMidnight("2026-10-05"),
      sourceType: "Contract",
      sourceId: id.contract,
    },
  });
  await db.csmPulse.create({
    data: {
      ...a,
      membershipId,
      value: "WORRIED",
      createdAt: at("2026-10-02"),
      expiresAt: at("2026-11-20"),
    },
  });
  await db.account.update({
    where: { id: accountId },
    data: {
      tier: "HIGH_TOUCH",
      lifecycleStage: "LOST",
      churnedAt: at(LATER),
      arrMinor: 7_000_000n,
    },
  });
});

describe("scoreAsOf never looks ahead (M3 rule 4)", () => {
  it("gives the identical result and inputs after the post-date plants", async () => {
    const after = (await scoreAsOf(ctx, [accountId], D)).get(accountId)!;
    expect(after.score).toEqual(before.score);
    expect(after.inputsHash).toBe(before.inputsHash);
  });

  it("does see the plants when scoring as of a later date (the fixture is sensitive)", async () => {
    const later = (await scoreAsOf(ctx, [accountId], LATER)).get(accountId)!;
    expect(later.score.overall).not.toBe(before.score.overall);
  });

  const at2 = async (date: string) => (await scoreAsOf(ctx, [accountId], date)).get(accountId)!;
  const reason = (s: ScoredAccount, component: string) =>
    s.score.reasons.find((r) => r.component === component)!;

  it("usage and replies after the date are invisible", async () => {
    const d = await at2(D);
    expect(reason(d, "active_vs_own").message).toMatch(/at this account's normal \(20 vs 20/);
    expect(reason(d, "last_customer_reply").message).toBe(
      "The customer last wrote back 10 days ago (Sep 20, 2026).",
    );
    expect((await at2(LATER)).bundle.usage!.at(-1)!.activeUsers).toBe(0);
  });

  it("tickets opened later and escalations made later do not count (escalatedAt)", async () => {
    const d = await at2(D);
    expect(reason(d, "escalations_30d").message).toBe(
      "No tickets were escalated in the last 30 days.",
    );
    expect(d.bundle.tickets.map((t) => t.subject)).toEqual(["Old open ticket"]);
    expect(reason(await at2(LATER), "escalations_30d").message).toBe(
      "2 tickets were escalated in the last 30 days.",
    );
  });

  it("invoices issued, failed or re-counted later do not count (failureCount never read)", async () => {
    const d = await at2(D);
    expect(reason(d, "invoices_90d").score).toBe(100);
    expect(d.bundle.invoices.map((i) => i.number)).toEqual(["INV-1"]);
    expect(JSON.stringify(d.bundle)).not.toMatch(/failureCount/);
    expect(reason(await at2(LATER), "invoices_90d").score).toBe(30);
  });

  it("a contact's status counts only from statusChangedAt", async () => {
    expect(reason(await at2(D), "champion_present").message).toBe(
      "Champion Cara Champion is active.",
    );
    expect(reason(await at2(LATER), "champion_present").message).toBe(
      "Champion Cara Champion has left the company (Oct 10, 2026).",
    );
  });

  it("roles count only while valid on the date", async () => {
    expect(reason(await at2(D), "decision_maker").message).toBe(
      "Decision maker Dan Decider is on record.",
    );
    expect(reason(await at2(LATER), "decision_maker").message).toBe(
      "No decision maker since Dan Decider's role ended (Oct 1, 2026).",
    );
  });

  it("tier is rebuilt from ARR as of the date, not the account's current tier", async () => {
    expect((await at2(D)).bundle.tier).toBe("MID_TOUCH");
    expect(reason(await at2(D), "breadth").message).toMatch(/we expect 3 for a Mid-touch account/);
    expect((await at2(LATER)).bundle.tier).toBe("HIGH_TOUCH");
  });

  it("a Pulse given later does not count; lifecycle and churn date are never read", async () => {
    const d = await at2(D);
    expect(d.bundle.pulse).toBeNull();
    expect(d.score.pulse).toBeNull();
    expect(JSON.stringify(d.bundle)).not.toMatch(/LOST|churnedAt|lifecycleStage/);
    expect((await at2(LATER)).score.pulse?.value).toBe("WORRIED");
  });
});
