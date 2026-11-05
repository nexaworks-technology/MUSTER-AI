import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@prisma/client";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { getAccount, listAccounts, type Actor } from "@/modules/accounts/service";
import { accountListQuery } from "@/modules/accounts/schemas";
import { getBilling } from "@/modules/billing/service";
import { runAskTool, type AskActor } from "@/modules/ask-ai/service";
import { loadLedger, type LedgerActor } from "@/modules/outcomes/service";
import { getRevenueView } from "@/modules/revenue/service";
import { listRenewals } from "@/modules/renewals/service";
import { filtersHash, getLatestReport } from "@/modules/reports/service";
import { normalizeFilters, reportFilters } from "@/modules/reports/schemas";

/**
 * M12 A7: money redaction on every financial projection, as a member WITHOUT canViewRevenue and
 * one WITH it (ARCHITECTURE §7.2: "Without canViewRevenue, money fields are stripped server-side").
 * Every money value is seeded as a distinct digit string, so a leak in any format (minor units,
 * formatted, nested in JSON) is found by searching the serialized output.
 *
 * The data-export projection is covered when Session B's export (B1) lands.
 */
const ARR = 7_654_321n;
const SUB = 4_321_987n;
const INV = 2_468_135n;
const DELTA = 1_357_911n;
const REPORT_FIGURE = 5_550_123n;
const SAVED = 9_876_543n;
const ALL_MONEY = [ARR, SUB, INV, DELTA, REPORT_FIGURE, SAVED].map(String);
/** Digits of the same figure with the decimal point and separators: 76,543.21 / 76543.21. */
const formatted = (minor: bigint) => {
  const s = minor.toString();
  const whole = s.slice(0, -2);
  return [`${whole}.${s.slice(-2)}`, `${Number(whole).toLocaleString("en-US")}.${s.slice(-2)}`];
};

const dump = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

function expectNoMoney(out: unknown, which: string[] = ALL_MONEY) {
  const text = dump(out);
  for (const m of which) expect(text, `leaked ${m}`).not.toContain(m);
  for (const m of which) for (const f of formatted(BigInt(m))) expect(text).not.toContain(f);
}

async function member(ws: string, role: Role, canViewRevenue: boolean) {
  const user = await rawDb.user.create({
    data: { email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, name: role },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: {
        workspaceId: ws,
        userId: user.id,
        role,
        bookScope: role === "CSM" ? "OWN" : "ALL",
        canViewRevenue,
      },
    });
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  } satisfies Actor;
}

const NOW = new Date("2026-11-05T12:00:00Z");
const clock = () => NOW;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let admin: Actor;
let ws: string;
let accountId: string;
// Restricted = no revenue flag (including an Admin with the flag turned off); allowed = flag on.
let restricted: { name: string; actor: Actor }[];
let allowed: { name: string; actor: Actor }[];

const asLedger = (a: Actor): LedgerActor => ({ ...a, workspace: { timezone: "UTC" } });
const asAsk = (a: Actor): AskActor => a;

beforeAll(async () => {
  const created = await createTestAdmin("RevRedact");
  admin = created.actor;
  ws = admin.workspaceId;
  const db = scopedDb(admin);

  const leaderOff = await member(ws, "CS_LEADER", false);
  const adminOff = await member(ws, "ADMIN", false);
  const csmOff = await member(ws, "CSM", false);
  const leaderOn = await member(ws, "CS_LEADER", true);
  const viewerOn = await member(ws, "VIEWER", true);
  restricted = [
    { name: "CS_LEADER without the flag", actor: leaderOff },
    { name: "ADMIN with the flag turned off", actor: adminOff },
    { name: "CSM (own book) without the flag", actor: csmOff },
  ];
  allowed = [
    { name: "ADMIN with the flag", actor: admin },
    { name: "CS_LEADER with the flag", actor: leaderOn },
    { name: "VIEWER with the flag", actor: viewerOn },
  ];

  // The account is owned by the CSM so even the CSM's own-book view contains it.
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Redaction Co",
      tier: "MID_TOUCH",
      ownerMembershipId: csmOff.membershipId,
      arrMinor: ARR,
      arrCurrency: "USD",
    },
  });
  accountId = account.id;
  const soon = new Date(Date.now() + 30 * 86_400_000);
  const renewalDate = new Date(
    Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate()),
  );
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId,
      startDate: new Date("2026-01-01"),
      renewalDate,
      valueMinor: ARR,
      currency: "USD",
    },
  });
  const sub = await db.subscription.create({
    data: {
      workspaceId: ws,
      accountId,
      contractId: contract.id,
      plan: "Pro",
      interval: "YEAR",
      amountMinor: SUB,
      currency: "USD",
    },
  });
  await db.invoice.create({
    data: {
      workspaceId: ws,
      accountId,
      subscriptionId: sub.id,
      number: "INV-1",
      amountMinor: INV,
      currency: "USD",
      issuedAt: new Date("2026-10-01"),
      dueAt: new Date("2026-10-31"),
    },
  });
  await db.revenueEvent.create({
    data: {
      workspaceId: ws,
      accountId,
      type: "EXPANSION",
      deltaArrMinor: DELTA,
      currency: "USD",
      effectiveDate: new Date("2026-10-15"),
      sourceType: "Contract",
      sourceId: contract.id,
    },
  });
  await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId,
      contractId: contract.id,
      renewalDate,
      arrAtRiskMinor: ARR,
      currency: "USD",
      confidence: 60,
      confidenceBand: "MEDIUM",
      confidenceAsOf: renewalDate,
    },
  });

  // A stored report snapshot with a money figure, for the whole-workspace book (leaders/admins).
  const filters = normalizeFilters(reportFilters.parse({}));
  await db.reportSnapshot.create({
    data: {
      workspaceId: ws,
      reportKey: "renewal-outcomes",
      periodStart: day("2026-08-01"),
      periodEnd: day("2026-10-30"),
      filters: filters as object,
      filtersHash: filtersHash(filters, admin, "ALL"),
      generatedAt: NOW,
      trigger: "MANUAL",
      generatedByMembershipId: admin.membershipId,
      data: {
        reportKey: "renewal-outcomes",
        periodStart: "2026-08-01",
        periodEnd: "2026-10-30",
        accountsInScope: 1,
        notes: [],
        sections: [
          {
            title: "Renewed",
            figures: [
              {
                label: "ARR renewed",
                value: REPORT_FIGURE.toString(),
                unit: "money",
                currency: "USD",
                sources: { type: "Renewal", ids: [accountId] },
              },
              { label: "Renewals", value: 1, unit: "count", sources: { type: "Renewal", ids: [] } },
            ],
          },
        ],
      },
    },
  });

  // An acted, saved outcome record with money, for the ledger.
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      title: "t",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: accountId }],
      values: {},
      params: {},
      dedupeKey: `d:${randomUUID()}`,
      firstSeenAt: new Date("2026-07-01T09:00:00Z"),
      lastSeenAt: new Date("2026-07-01T09:00:00Z"),
    },
  });
  await db.outcomeRecord.create({
    data: {
      workspaceId: ws,
      accountId,
      signalId: signal.id,
      flagType: "RISK",
      flaggedAt: new Date("2026-07-01T09:00:00Z"),
      arrAtFlagMinor: SAVED,
      arrCurrency: "USD",
      actionTaken: "ACTED",
      firstActionAt: new Date("2026-07-01T09:00:00Z"),
      valueSavedMinor: SAVED,
      d90Outcome: {
        day: 90,
        status: "RENEWED",
        dueOn: "2026-09-29",
        actionTaken: "ACTED",
        evidence: [],
        detail: "d",
        attributed: true,
        note: "n",
      },
    },
  });
});

describe("accounts list and Account 360 header", () => {
  it("without the flag: no ARR key, no value anywhere", async () => {
    for (const { name, actor } of restricted) {
      const list = await listAccounts(actor, accountListQuery.parse({}));
      expect(list.arrVisible, name).toBe(false);
      expect(
        list.rows.every((r) => !("arr" in r)),
        name,
      ).toBe(true);
      expectNoMoney(list);
      const acct = await getAccount(actor, accountId);
      expect(acct, `${name} sees the account`).not.toBeNull();
      expect(acct?.arrVisible, name).toBe(false);
      expect(acct?.arr, name).toBeNull();
      expectNoMoney(acct);
    }
  });

  it("with the flag: ARR is present", async () => {
    for (const { name, actor } of allowed) {
      const list = await listAccounts(actor, accountListQuery.parse({}));
      expect(list.arrVisible, name).toBe(true);
      expect(dump(list), name).toContain(ARR.toString());
      const acct = await getAccount(actor, accountId);
      expect(acct?.arr?.minor, name).toBe(ARR);
    }
  });
});

describe("billing (contracts, invoices, subscriptions, revenue events)", () => {
  it("without the flag: money keys are removed entirely and terms are not decrypted", async () => {
    for (const { name, actor } of restricted) {
      const b = await getBilling(actor, accountId);
      expect(b.moneyVisible, name).toBe(false);
      expect(b.contracts, name).toHaveLength(1);
      expect(b.contracts[0] && "valueMinor" in b.contracts[0], name).toBe(false);
      expect(b.subscriptions[0] && "amountMinor" in b.subscriptions[0], name).toBe(false);
      expect(b.invoices[0] && "amountMinor" in b.invoices[0], name).toBe(false);
      expect(b.revenueEvents[0] && "deltaArrMinor" in b.revenueEvents[0], name).toBe(false);
      expectNoMoney(b);
    }
  });

  it("with the flag: every figure is present", async () => {
    for (const { name, actor } of allowed) {
      const b = await getBilling(actor, accountId);
      expect(b.moneyVisible, name).toBe(true);
      const text = dump(b);
      for (const m of [ARR, SUB, INV, DELTA]) expect(text, `${name} ${m}`).toContain(m.toString());
    }
  });
});

describe("renewals list (arrAtRisk + forecast)", () => {
  it("without the flag: row money and the forecast are absent", async () => {
    for (const { name, actor } of restricted) {
      const r = await listRenewals(actor, { days: 365 }, () => new Date());
      expect(r.moneyVisible, name).toBe(false);
      expect(r.forecast, name).toBeNull();
      expect(r.rows.length, `${name} sees the renewal`).toBe(1);
      expect(
        r.rows.every((x) => !("arrMinor" in x) && !("currency" in x)),
        name,
      ).toBe(true);
      expectNoMoney(r);
    }
  });

  it("with the flag: arrAtRisk and the forecast carry the figure", async () => {
    for (const { name, actor } of allowed) {
      const r = await listRenewals(actor, { days: 365 }, () => new Date());
      expect(r.moneyVisible, name).toBe(true);
      expect(r.forecast, name).not.toBeNull();
      expect(r.rows[0]?.arrMinor, name).toBe(ARR);
      expect(dump(r.forecast), name).toContain(ARR.toString());
    }
  });
});

describe("revenue view", () => {
  it("without the flag: refused before any figure is computed", async () => {
    for (const { name, actor } of restricted)
      await expect(getRevenueView(actor, {}, clock), name).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("with the flag: figures are present", async () => {
    for (const { name, actor } of allowed) {
      const v = await getRevenueView(actor, { from: "2026-08-01", to: "2026-11-05" }, clock);
      const text = dump(v);
      expect(text, name).toContain(DELTA.toString());
      expect(text, name).toContain(ARR.toString());
    }
  });
});

describe("report snapshots (read path)", () => {
  const leaderOnly = (xs: typeof restricted) => xs.filter((x) => x.actor.bookScope === "ALL");

  it("without the flag: money figures are replaced by a restricted marker with no value or sources", async () => {
    for (const { name, actor } of leaderOnly(restricted)) {
      const r = await getLatestReport(actor, "renewal-outcomes", {});
      expect(r, `${name} reads the snapshot`).not.toBeNull();
      const money = r!.data.sections.flatMap((s) => s.figures).filter((f) => f.unit === "money");
      expect(money.length).toBeGreaterThan(0);
      for (const f of money) {
        expect(f.value, name).toBeNull();
        expect(f.restricted, name).toBe(true);
        expect(f.sources.ids, name).toEqual([]);
      }
      expectNoMoney(r);
    }
  });

  it("with the flag: the money figure is shown", async () => {
    for (const { name, actor } of allowed.filter((x) => x.actor.bookScope === "ALL")) {
      const r = await getLatestReport(actor, "renewal-outcomes", {});
      expect(dump(r), name).toContain(REPORT_FIGURE.toString());
    }
  });
});

describe("outcome ledger", () => {
  it("without the flag: money totals are RESTRICTED and no value is in the view", async () => {
    for (const { name, actor } of restricted) {
      const v = await loadLedger(asLedger(actor), { period: 365 }, clock);
      expect(v.ledger.records.length, `${name} sees the record`).toBeGreaterThan(0);
      expectNoMoney(v);
    }
  });

  it("with the flag: the saved value is in the ledger", async () => {
    for (const { name, actor } of allowed) {
      const v = await loadLedger(asLedger(actor), { period: 365 }, clock);
      expect(dump(v), name).toContain(SAVED.toString());
    }
  });
});

describe("Ask AI tools", () => {
  const TOOLS: [string, Record<string, unknown>][] = [
    ["getContract", { accountId: undefined }],
    ["searchAccounts", { query: "" }],
    ["listRenewals", { days: 365 }],
  ];
  const input = (i: Record<string, unknown>) => ({
    ...i,
    ...("accountId" in i ? { accountId } : {}),
  });

  for (const [tool, i] of TOOLS) {
    it(`${tool}: no money without the flag`, async () => {
      for (const { name, actor } of restricted) {
        const out = await runAskTool(asAsk(actor), tool, input(i));
        expectNoMoney(out);
        expect(dump(out), name).not.toMatch(/"(arr|value|amount|price|delta)[A-Za-z]*"\s*:/i);
      }
    });
  }

  it("getContract with the flag cites the contract value", async () => {
    for (const { name, actor } of allowed) {
      const out = await runAskTool(asAsk(actor), "getContract", { accountId });
      expect(dump(out), name).toContain(formatted(ARR)[0]);
    }
  });

  it("listRenewals and searchAccounts with the flag carry the figure where the tool shows money", async () => {
    const renewals = await runAskTool(asAsk(admin), "listRenewals", { days: 365 });
    const search = await runAskTool(asAsk(admin), "searchAccounts", { query: "" });
    expect(dump(renewals)).toContain(formatted(ARR)[0]);
    expect(dump(search)).toContain(formatted(ARR)[0]);
  });
});
