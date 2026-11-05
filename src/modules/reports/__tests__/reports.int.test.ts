import { randomUUID } from "node:crypto";
import type { BookScope, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { getActiveModel, healthOverview } from "@/modules/health/service";
import { listRenewals } from "@/modules/renewals/service";
import { getAdoption } from "@/modules/usage/service";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { generateReport, getLatestReport, listReports } from "../service";
import { REPORT_KEYS, type Figure, type ReportData } from "../types";

/** The business date every test runs on: 2026-11-02 in the workspace's (UTC) time zone. */
const clock = () => new Date("2026-11-02T12:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

async function addMember(
  workspaceId: string,
  role: Role,
  opts: { canViewRevenue: boolean; bookScope: BookScope },
): Promise<Actor> {
  const id = randomUUID().slice(0, 8);
  const user = await rawDb.user.create({
    data: { email: `${role.toLowerCase()}-${id}@example.test`, name: `${role} ${id}` },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({ data: { workspaceId, userId: user.id, role, ...opts } });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  };
}

type Risk = "AT_RISK" | "WATCH" | "HEALTHY";

/** One account with the records every report reads (a contract, usage, health, a renewal ...). */
async function addAccount(
  w: Admin,
  name: string,
  o: {
    owner?: string | null;
    risk?: Risk;
    arrMinor?: bigint | null;
    tier?: "MID_TOUCH" | "HIGH_TOUCH";
  } = {},
) {
  const ws = w.workspace.id;
  const db = scopedDb(w.actor);
  const model = await getActiveModel(w.actor);
  const arr = o.arrMinor === undefined ? 100_00n : o.arrMinor;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name,
      tier: o.tier ?? "MID_TOUCH",
      plan: "pro",
      ownerMembershipId: o.owner === undefined ? w.membership.id : o.owner,
      arrMinor: arr,
      arrCurrency: arr === null ? null : "USD",
    },
  });
  const risk = o.risk ?? "WATCH";
  const snap = async (asOf: string, riskLevel: Risk, isBacktest = false) => {
    const id = randomUUID();
    const reasonId = randomUUID();
    await db.$tenantTransaction(async (tx) => {
      await tx.healthScoreSnapshot.create({
        data: {
          id,
          workspaceId: ws,
          accountId: account.id,
          healthModelId: model.id,
          asOf: d(asOf),
          overall: 50,
          riskLevel,
          riskLevelExcludingPulse: riskLevel,
          effectiveWeights: {},
          inputsHash: id,
          isBacktest,
          riskReasonId: riskLevel === "AT_RISK" ? reasonId : null,
        },
      });
      if (riskLevel === "AT_RISK")
        await tx.healthReason.create({
          data: {
            id: reasonId,
            workspaceId: ws,
            snapshotId: id,
            pillar: "ADOPTION",
            component: "c",
            kind: "EVIDENCE",
            direction: "DOWN",
            impact: -5,
            input: "i",
            message: "m",
            sources: [{ sourceType: "Account", sourceId: account.id }],
          },
        });
    });
    return { id };
  };
  await snap("2026-10-26", "HEALTHY");
  const current = await snap("2026-11-02", risk);
  await db.account.update({
    where: { id: account.id },
    data: { currentHealthSnapshotId: current.id },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d("2026-01-01"),
      renewalDate: d("2026-12-01"),
      valueMinor: arr,
      currency: "USD",
      seatsPurchased: 10,
      status: "ACTIVE",
    },
  });
  await db.usageDaily.createMany({
    data: ["2026-10-30", "2026-10-31", "2026-11-01"].map((date) => ({
      workspaceId: ws,
      accountId: account.id,
      date: d(date),
      activeUsers: 3,
      sessions: 3,
      events: 9,
      seatsUsed: 4,
    })),
  });
  await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      contractId: contract.id,
      renewalDate: d("2026-12-01"),
      arrAtRiskMinor: arr,
      currency: arr === null ? null : "USD",
      confidence: 80,
      confidenceBand: "HIGH",
      confidenceAsOf: d("2026-11-02"),
    },
  });
  const past = await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      contractId: contract.id,
      renewalDate: d("2026-10-10"),
      arrAtRiskMinor: arr,
      currency: arr === null ? null : "USD",
      confidence: 60,
      confidenceBand: "MEDIUM",
      confidenceAsOf: d("2026-10-01"),
      stage: "RENEWED",
    },
  });
  await db.renewalOutcome.create({
    data: {
      workspaceId: ws,
      renewalId: past.id,
      accountId: account.id,
      result: "RENEWED",
      occurredOn: d("2026-10-10"),
      outcomeArrMinor: arr,
      currency: arr === null ? null : "USD",
      detectedVia: "CONTRACT_RECORDS",
      forecastConfidence: 60,
      forecastBand: "MEDIUM",
      forecastAsOf: d("2026-10-01"),
      forecastArrAtRiskMinor: arr,
    },
  });
  await db.ticket.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      subject: "Cannot log in",
      openedAt: new Date("2026-10-30T09:00:00Z"),
      firstResponseAt: new Date("2026-10-30T11:00:00Z"),
    },
  });
  await db.expansionOpportunity.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      estimateMinor: 40_00n,
      currency: "USD",
      estimateMethod: "SEATS_OVER_LIMIT",
      createdAt: new Date("2026-10-20T00:00:00Z"),
    },
  });
  await db.outcomeRecord.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      flagType: "RISK",
      flaggedAt: new Date("2026-10-15T00:00:00Z"),
    },
  });
  if (o.owner !== null)
    await db.task.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        title: "Call",
        ownerMembershipId: o.owner ?? w.membership.id,
      },
    });
  return { account, snap };
}

const figures = (r: ReportData): Figure[] => r.sections.flatMap((s) => s.figures);
const find = (r: ReportData, label: string) => {
  const f = figures(r).find((x) => x.label === label);
  if (!f) throw new Error(`no figure ${label}`);
  return f;
};
const allIds = (r: ReportData) => new Set(figures(r).flatMap((f) => f.sources.ids));

describe("reports: tenant isolation", () => {
  it("another workspace's data never appears and its snapshot is not readable", async () => {
    const A = await createTestAdmin("RepA");
    const B = await createTestAdmin("RepB");
    const a = await addAccount(A, "Alpha Co");
    const b = await addAccount(B, "Beta Co", { risk: "AT_RISK" });

    const ra = await generateReport(A.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    const rb = await generateReport(B.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    expect(ra.data.accountsInScope).toBe(1);
    expect(find(ra.data, "At Risk now").value).toBe(0);
    expect(find(rb.data, "At Risk now").value).toBe(1);

    for (const key of REPORT_KEYS) {
      const r = await generateReport(A.actor, key, {}, "MANUAL", clock);
      const json = JSON.stringify(r);
      expect(json).not.toContain(b.account.id);
      expect(json).not.toContain("Beta Co");
    }
    expect(
      allIds((await getLatestReport(A.actor, "portfolio-health-trend", {}))!.data),
    ).not.toContain(b.account.id);
    expect(await scopedDb(A.actor).reportSnapshot.findUnique({ where: { id: rb.id } })).toBeNull();
    expect(a.account.id).toBeTruthy();
  });
});

describe("reports: book scope", () => {
  it("a CSM with an own book sees only their accounts, whatever filters the client sends", async () => {
    const W = await createTestAdmin("RepBook");
    const csm = await addMember(W.workspace.id, "CSM", { canViewRevenue: false, bookScope: "OWN" });
    const mine = await addAccount(W, "Mine", { owner: csm.membershipId });
    const theirs = await addAccount(W, "Theirs"); // owned by the admin

    const own = await generateReport(csm, "portfolio-health-trend", {}, "MANUAL", clock);
    expect(own.data.accountsInScope).toBe(1);
    const json = JSON.stringify(own);
    expect(json).toContain(mine.account.id);
    expect(json).not.toContain(theirs.account.id);

    // Asking for someone else's accounts narrows the book to nothing; it never widens it.
    const other = await generateReport(
      csm,
      "portfolio-health-trend",
      { owner: W.membership.id },
      "MANUAL",
      clock,
    );
    expect(other.data.accountsInScope).toBe(0);
    expect(find(other.data, "At Risk now").reason).toMatch(/No accounts/);

    // The leader's snapshot for the same filters is not the CSM's to read.
    await generateReport(W.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    const seen = await getLatestReport(csm, "portfolio-health-trend", {});
    expect(seen?.id).toBe(own.id);
    expect(seen?.data.accountsInScope).toBe(1);
  });

  it("input is validated: an unknown report or a bad filter is refused, nothing is stored", async () => {
    const W = await createTestAdmin("RepBad");
    await expect(generateReport(W.actor, "nonsense", {}, "MANUAL", clock)).rejects.toThrow();
    await expect(
      generateReport(W.actor, "adoption", { periodDays: 45 }, "MANUAL", clock),
    ).rejects.toThrow(/30, 90, 180 or 365/);
    await expect(
      generateReport(W.actor, "adoption", { start: "2026-10-01" }, "MANUAL", clock),
    ).rejects.toThrow(/start and an end/);
    await expect(
      generateReport(W.actor, "adoption", { segment: "no-such-segment" }, "MANUAL", clock),
    ).rejects.toThrow(/segment/i);
    expect(await scopedDb(W.actor).reportSnapshot.count()).toBe(0);
  });
});

describe("reports: money redaction at read time", () => {
  it("a viewer without revenue access gets counts intact and money restricted, from the same snapshot", async () => {
    const W = await createTestAdmin("RepMoney");
    await addAccount(W, "Moneyed", { arrMinor: 123_456_00n });
    const full = await generateReport(W.actor, "renewal-outcomes", {}, "MANUAL", clock);
    const arr = find(full.data, "ARR renewed");
    expect(arr).toMatchObject({ unit: "money", value: "12345600", currency: "USD" });

    const viewer = await addMember(W.workspace.id, "VIEWER", {
      canViewRevenue: false,
      bookScope: "ALL",
    });
    const seen = await getLatestReport(viewer, "renewal-outcomes", {});
    expect(seen?.id).toBe(full.id);
    expect(find(seen!.data, "ARR renewed")).toMatchObject({
      value: null,
      restricted: true,
      sources: { ids: [] },
    });
    expect(find(seen!.data, "Renewed").value).toBe(1);
    expect(JSON.stringify(seen)).not.toContain("12345600");
    for (const f of figures(seen!.data)) if (f.unit === "money") expect(f.restricted).toBe(true);

    // The same holds for every report, not just this one.
    for (const key of REPORT_KEYS) {
      await generateReport(W.actor, key, {}, "MANUAL", clock);
      const r = await getLatestReport(viewer, key, {});
      for (const f of figures(r!.data))
        if (f.unit === "money") expect(f).toMatchObject({ value: null, restricted: true });
      expect(JSON.stringify(r)).not.toContain("12345600");
    }
  });
});

describe("reports: back-test rows never enter (D-158)", () => {
  it("the health trend is identical with and without isBacktest snapshots", async () => {
    const W = await createTestAdmin("RepBt");
    const a = await addAccount(W, "Bt One", { risk: "WATCH" });
    const before = await generateReport(W.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    // Replays that would change every band on every date if they were read.
    for (const day of ["2026-10-12", "2026-10-26", "2026-11-01", "2026-11-02"])
      await a.snap(day, "AT_RISK", true);
    const after = await generateReport(W.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    expect(after.id).not.toBe(before.id);
    expect(after.data.sections).toEqual(before.data.sections);
    expect(find(after.data, "At Risk now").value).toBe(0);
  });
});

describe("reports: snapshots are immutable records", () => {
  it("generating adds a dated row and an audit entry; updating content is refused", async () => {
    const W = await createTestAdmin("RepImm");
    await addAccount(W, "Imm");
    const first = await generateReport(W.actor, "support-risk", {}, "MANUAL", clock);
    const second = await generateReport(W.actor, "support-risk", {}, "MANUAL", clock);
    expect(second.id).not.toBe(first.id);
    const db = scopedDb(W.actor);
    await expect(
      db.reportSnapshot.updateMany({ where: { id: first.id }, data: { data: { tampered: true } } }),
    ).rejects.toThrow(/immutable/i);
    const audits = await db.auditLog.findMany({
      where: { action: "report.generated", targetId: { in: [first.id, second.id] } },
    });
    expect(audits).toHaveLength(2);
    expect((await getLatestReport(W.actor, "support-risk", {}))?.id).toBe(second.id);
  });

  it("lists the seven reports with the latest generated date", async () => {
    const W = await createTestAdmin("RepList");
    await addAccount(W, "Lst");
    expect((await listReports(W.actor)).every((r) => r.latest === null)).toBe(true);
    await generateReport(W.actor, "adoption", {}, "MANUAL", clock);
    const list = await listReports(W.actor);
    expect(list).toHaveLength(7);
    expect(list.find((r) => r.key === "adoption")?.latest?.id).toBeTruthy();
  });
});

describe("reports: parity with the screens (no parallel calculation)", () => {
  it("portfolio health 'now' equals healthOverview for the same book", async () => {
    const W = await createTestAdmin("RepParH");
    await addAccount(W, "P1", { risk: "AT_RISK" });
    await addAccount(W, "P2", { risk: "AT_RISK", arrMinor: null });
    await addAccount(W, "P3", { risk: "HEALTHY" });
    const un = await scopedDb(W.actor).account.create({
      data: { workspaceId: W.workspace.id, name: "Never scored", tier: "MID_TOUCH" },
    });
    expect(un.id).toBeTruthy();
    const screen = await healthOverview(W.actor, clock);
    const report = await generateReport(W.actor, "portfolio-health-trend", {}, "MANUAL", clock);
    expect(find(report.data, "At Risk now").value).toBe(screen.bands.AT_RISK.count);
    expect(find(report.data, "Watch now").value).toBe(screen.bands.WATCH.count);
    expect(find(report.data, "Healthy now").value).toBe(screen.bands.HEALTHY.count);
    expect(find(report.data, "Not scored yet").value).toBe(screen.unscored);
    expect(find(report.data, "ARR in At Risk now").value).toBe(
      screen.bands.AT_RISK.arrMinor?.toString(),
    );
  });

  it("the renewal forecast equals listRenewals' forecast for the same window", async () => {
    const W = await createTestAdmin("RepParR");
    await addAccount(W, "R1", { arrMinor: 200_00n });
    await addAccount(W, "R2", { arrMinor: 50_00n });
    await addAccount(W, "R3", { arrMinor: null });
    const screen = await listRenewals(W.actor, { days: 90 }, clock);
    const report = await generateReport(W.actor, "renewal-outcomes", {}, "MANUAL", clock);
    expect(screen.forecast).not.toBeNull();
    expect(find(report.data, "Forecast ARR, High confidence").value).toBe(
      screen.forecast!.byBand.HIGH.arrMinor.toString(),
    );
    expect(find(report.data, "Renewals due in the next 90 days").value).toBe(screen.total);
    expect(find(report.data, "Upcoming renewals with no ARR on file").sources.ids).toEqual(
      screen.forecast!.noArrIds,
    );
  });

  it("an account's seats in use equal the Adoption tab's", async () => {
    const W = await createTestAdmin("RepParA");
    const a = await addAccount(W, "Ad1");
    const tab = await getAdoption(W.actor, a.account.id, clock);
    const report = await generateReport(W.actor, "adoption", {}, "MANUAL", clock);
    expect(find(report.data, "Seats in use").value).toBe(tab.seats!.used);
    expect(find(report.data, "Seats bought (accounts with usage)").value).toBe(
      tab.seats!.purchased,
    );
  });
});

describe("reports: query budget (no N+1)", () => {
  it("generation costs the same number of queries for 2 accounts and 5", async () => {
    const small = await createTestAdmin("RepQ2");
    const big = await createTestAdmin("RepQ5");
    for (let i = 0; i < 2; i++) await addAccount(small, `S${i}`);
    for (let i = 0; i < 5; i++) await addAccount(big, `B${i}`);
    for (const key of REPORT_KEYS) {
      // Warm: the first run may create the default health model.
      await generateReport(small.actor, key, {}, "MANUAL", clock);
      await generateReport(big.actor, key, {}, "MANUAL", clock);
      const s = await countQueries(() => generateReport(small.actor, key, {}, "MANUAL", clock));
      const b = await countQueries(() => generateReport(big.actor, key, {}, "MANUAL", clock));
      expect(b.queries, key).toBe(s.queries);
      expect(b.result.data.accountsInScope).toBe(5);
    }
  }, 120_000);
});
