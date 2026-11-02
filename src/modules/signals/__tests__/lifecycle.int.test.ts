import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { acknowledgeSignal, evaluateAndStore, markFalseAlarm } from "../service";

/**
 * Signal lifecycle (M3 rule 8, D-53, D-57): re-runs never duplicate; a cleared condition is
 * resolved by the system with its reason; a new episode opens after resolution; a false alarm
 * stays suppressed until materially worse; every new episode of WARN or above gets an outcome.
 */
const D1 = "2026-11-02";
const clock = () => new Date("2026-11-02T03:00:00Z");
let admin: Actor;
let viewer: Actor;
let ws: string;
let db: ReturnType<typeof scopedDb>;
let accountId: string;

/** Usage: normal 40, then `recent` users a day for the last 14 days before `asOf`. */
async function setUsage(asOf: string, recent: number) {
  await db.usageDaily.deleteMany({ where: { accountId } });
  await db.usageDaily.createMany({
    data: Array.from({ length: 130 }, (_, i) => {
      const d = 130 - i;
      return {
        workspaceId: ws,
        accountId,
        date: utcMidnight(addDays(asOf, -d)),
        activeUsers: d <= 14 ? recent : 40,
        sessions: 0,
        events: 0,
      };
    }),
  });
}
const usageSignals = () =>
  db.signal.findMany({
    where: { accountId, ruleKey: "usage_drop_vs_normal" },
    orderBy: { episode: "asc" },
  });

beforeAll(async () => {
  admin = (await createTestAdmin("Lifecycle")).actor;
  ws = admin.workspaceId;
  db = scopedDb(admin);
  const user = await db.user.create({ data: { email: `v-${ws}@example.test`, name: "V" } });
  const m = await db.membership.create({
    data: { workspaceId: ws, userId: user.id, role: "VIEWER" },
  });
  viewer = {
    ...admin,
    userId: user.id,
    membershipId: m.id,
    role: "VIEWER",
    canViewRevenue: false,
    bookScope: "ALL",
  };
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Cycle",
        tier: "MID_TOUCH",
        arrMinor: 3_000_000n,
        arrCurrency: "USD",
      },
    })
  ).id;
});

describe("signal lifecycle", () => {
  it("opens once and re-running the same day creates no duplicate", async () => {
    await setUsage(D1, 24); // 60% of normal → WARN
    const first = await evaluateAndStore(admin, [accountId], D1, clock);
    const again = await evaluateAndStore(admin, [accountId], D1, clock);
    expect(first.opened).toBe(1);
    expect(again).toEqual({ opened: 0, updated: 0, resolved: 0, suppressed: 0 });
    const rows = await usageSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "OPEN", severity: "WARN", episode: 1, ruleVersion: 1 });
    expect(rows[0]!.params).toMatchObject({ warnRatio: 0.7 });
    expect(rows[0]!.values).toMatchObject({ ratio: 0.6 });
    expect(await db.outboxEvent.count({ where: { type: "signal.opened", workspaceId: ws } })).toBe(
      1,
    );
  });

  it("creates one outcome record for the episode, with ARR at the flag (never 0 when unknown)", async () => {
    const [s] = await usageSignals();
    const o = await db.outcomeRecord.findUniqueOrThrow({
      where: { workspaceId_signalId: { workspaceId: ws, signalId: s!.id } },
    });
    expect(o).toMatchObject({
      flagType: "RISK",
      actionTaken: "PENDING",
      arrAtFlagMinor: 3_000_000n,
      arrCurrency: "USD",
    });
  });

  it("updates an open signal when it gets worse, keeping one row", async () => {
    await setUsage("2026-11-09", 12); // 30% → CRITICAL
    await evaluateAndStore(admin, [accountId], "2026-11-09", clock);
    const rows = await usageSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "CRITICAL", status: "OPEN" });
    expect(rows[0]!.lastSeenAt.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  it("resolves by itself, with a reason, when the condition clears", async () => {
    await setUsage("2026-11-16", 38);
    const r = await evaluateAndStore(admin, [accountId], "2026-11-16", clock);
    expect(r.resolved).toBe(1);
    const [s] = await usageSignals();
    expect(s).toMatchObject({ status: "RESOLVED" });
    expect(s!.resolvedReason).toMatch(/no longer detected/i);
    expect(
      await db.outboxEvent.count({ where: { type: "signal.resolved", workspaceId: ws } }),
    ).toBe(1);
  });

  it("opens a new episode (and a new outcome) when it comes back", async () => {
    await setUsage("2026-11-23", 20);
    await evaluateAndStore(admin, [accountId], "2026-11-23", clock);
    const rows = await usageSignals();
    expect(rows.map((r) => [r.episode, r.status])).toEqual([
      [1, "RESOLVED"],
      [2, "OPEN"],
    ]);
    expect(await db.outcomeRecord.count({ where: { accountId } })).toBe(2);
  });

  it("acknowledging keeps it live; viewers cannot acknowledge or mark false alarms", async () => {
    const live = (await usageSignals()).at(-1)!;
    await expect(acknowledgeSignal(viewer, live.id)).rejects.toBeInstanceOf(ForbiddenError);
    await acknowledgeSignal(admin, live.id);
    expect((await db.signal.findUniqueOrThrow({ where: { id: live.id } })).status).toBe(
      "ACKNOWLEDGED",
    );
    await evaluateAndStore(admin, [accountId], "2026-11-23", clock);
    expect(await usageSignals()).toHaveLength(2);
  });

  it("a false alarm stays suppressed on re-run while not materially worse (D-53)", async () => {
    const live = (await usageSignals()).at(-1)!;
    await expect(markFalseAlarm(viewer, live.id, "Seasonal")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await markFalseAlarm(admin, live.id, "Seasonal dip, they told us");
    const marked = await db.signal.findUniqueOrThrow({ where: { id: live.id } });
    expect(marked).toMatchObject({
      status: "FALSE_ALARM",
      falseAlarmReason: "Seasonal dip, they told us",
    });
    expect(
      await db.auditLog.count({ where: { action: "signal.false_alarm", targetId: live.id } }),
    ).toBe(1);
    await setUsage("2026-11-30", 17); // ratio 0.425 vs 0.5 when marked: 0.075 lower (< 0.15), same severity
    await evaluateAndStore(admin, [accountId], "2026-11-30", clock);
    expect(await usageSignals()).toHaveLength(2);
  });

  it("reopens as a new episode only when materially worse", async () => {
    await setUsage("2026-12-07", 10); // ratio 0.25 → CRITICAL: materially worse
    await evaluateAndStore(admin, [accountId], "2026-12-07", clock);
    const rows = await usageSignals();
    expect(rows.map((r) => [r.episode, r.status])).toEqual([
      [1, "RESOLVED"],
      [2, "FALSE_ALARM"],
      [3, "OPEN"],
    ]);
  });

  it("an INFO signal creates no outcome record", async () => {
    const c = await db.contract.create({
      data: {
        workspaceId: ws,
        accountId,
        startDate: utcMidnight("2026-01-01"),
        seatsPurchased: 40,
      },
    });
    await db.usageDaily.updateMany({ where: { accountId }, data: { seatsUsed: 37 } });
    await evaluateAndStore(admin, [accountId], "2026-12-07", clock);
    const s = await db.signal.findFirstOrThrow({
      where: { accountId, ruleKey: "seats_near_limit" },
    });
    expect(s).toMatchObject({
      severity: "INFO",
      polarity: "OPPORTUNITY",
      dedupeKey: `seats_near_limit:${accountId}:${c.id}`,
    });
    expect(await db.outcomeRecord.count({ where: { signalId: s.id } })).toBe(0);
  });
});
