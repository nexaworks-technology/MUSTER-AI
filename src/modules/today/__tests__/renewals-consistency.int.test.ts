import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin, createTestUser } from "@/test/fixtures";
import { listRenewals } from "@/modules/renewals/service";
import { countMyRenewalsDue, getToday } from "../service";

/**
 * FIX-2026-11-11 item 2. Today's renewals (the list and the "Renewals in 30 days" card) and the
 * Renewals page must read the same records (Renewal rows, one open-renewal window). They differ
 * only in whose accounts they cover: Today is "only for my accounts" (spec §5); the Renewals page
 * is everything the member's permissions allow. Every number below is checked against the page's
 * own function, so the two cannot drift apart again.
 */
const clock = () => new Date("2026-11-03T15:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function addMember(workspaceId: string, label: string, bookScope: "OWN" | "TEAM") {
  const user = await createTestUser(label);
  const membership = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({
      data: { workspaceId, userId: user.id, role: "CSM", bookScope, canViewRevenue: false },
    });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: membership.id,
    role: "CSM" as const,
    canViewRevenue: false,
    bookScope,
  };
}

async function seed(label: string) {
  const admin = await createTestAdmin(label);
  const ws = admin.workspace.id;
  const csmA = await addMember(ws, `${label}-a`, "OWN");
  const csmB = await addMember(ws, `${label}-b`, "OWN");
  const csmTeam = await addMember(ws, `${label}-t`, "TEAM");
  const db = scopedDb({ workspaceId: ws });
  const renewal = async (
    name: string,
    owner: string | null,
    renewalDate: string,
    opts: { stage?: "UPCOMING" | "RENEWED"; accountRenewalDate?: string | null } = {},
  ) => {
    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "MID_TOUCH",
        ownerMembershipId: owner,
        // The denormalised copy on the account may be absent or stale; Today must not depend on it.
        renewalDate:
          opts.accountRenewalDate === undefined
            ? day(renewalDate)
            : opts.accountRenewalDate === null
              ? null
              : day(opts.accountRenewalDate),
      },
    });
    const contract = await db.contract.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        startDate: day("2025-01-01"),
        endDate: day(renewalDate),
        valueMinor: 1_000_000n,
      },
    });
    await db.renewal.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        contractId: contract.id,
        renewalDate: day(renewalDate),
        arrAtRiskMinor: 1_000_000n,
        currency: "USD",
        confidence: 60,
        confidenceBand: "MEDIUM",
        confidenceAsOf: day("2026-11-03"),
        stage: opts.stage ?? "UPCOMING",
      },
    });
    return account;
  };
  const a1 = await renewal("A1 in 20d", csmA.membershipId, "2026-11-23");
  // No renewalDate on the account row at all: the Renewal record is the truth.
  const a2 = await renewal("A2 in 60d", csmA.membershipId, "2027-01-02", {
    accountRenewalDate: null,
  });
  await renewal("A3 in 200d", csmA.membershipId, "2027-05-22");
  await renewal("A4 already renewed", csmA.membershipId, "2026-12-01", { stage: "RENEWED" });
  const b1 = await renewal("B1 in 10d", csmB.membershipId, "2026-11-13");
  const u1 = await renewal("U1 unowned in 40d", null, "2026-12-13");
  return { admin, csmA, csmB, csmTeam, a1, a2, b1, u1 };
}

const todayRenewals = async (m: Parameters<typeof getToday>[0]) =>
  (await getToday(m, { clock })).find((s) => s.key === "RENEWAL")!;

describe("Today and Renewals read the same renewals (FIX-2026-11-11, item 2)", () => {
  it("a CSM: Today's list equals the Renewals page, account for account", async () => {
    const s = await seed("RenCsm");
    const today = await todayRenewals(s.csmA);
    const page = await listRenewals(s.csmA, { days: 90 }, clock);
    expect(page.total).toBe(2);
    expect(today.total).toBe(page.total);
    expect(new Set(today.items.map((i) => i.accountId))).toEqual(
      new Set(page.rows.map((r) => r.account.id)),
    );
  });

  it("an account with no renewalDate on its own row still shows: the Renewal record is the source", async () => {
    const s = await seed("RenStale");
    const today = await todayRenewals(s.csmA);
    expect(today.items.map((i) => i.accountId)).toContain(s.a2.id);
  });

  it("the 30-day card is computed from the same records as its list, on the same scope", async () => {
    const s = await seed("RenCard");
    for (const m of [s.csmA, s.csmB, s.csmTeam]) {
      const card = await countMyRenewalsDue(m, 30, clock);
      const page = await listRenewals(m, { days: 30 }, clock);
      expect(card).toBe(page.total);
    }
    expect(await countMyRenewalsDue(s.csmA, 30, clock)).toBe(1); // A1 only
    expect(await countMyRenewalsDue(s.csmA, 90, clock)).toBe((await todayRenewals(s.csmA)).total);
  });

  it("a TEAM-scope CSM sees the unowned pool on Today exactly as on the Renewals page", async () => {
    const s = await seed("RenTeam");
    const today = await todayRenewals(s.csmTeam);
    const page = await listRenewals(s.csmTeam, { days: 90 }, clock);
    expect(page.rows.map((r) => r.account.id)).toEqual([s.u1.id]);
    expect(today.items.map((i) => i.accountId)).toEqual([s.u1.id]);
  });

  it("Admin owns no accounts: Today is empty by design, while the Renewals page lists the workspace", async () => {
    const s = await seed("RenAdmin");
    const today = await todayRenewals(s.admin.actor);
    const mine = await listRenewals(
      s.admin.actor,
      { days: 90, owner: s.admin.membership.id },
      clock,
    );
    const everyone = await listRenewals(s.admin.actor, { days: 90 }, clock);
    expect(today.total).toBe(0);
    expect(today.total).toBe(mine.total); // same records, same owner filter
    expect(everyone.total).toBe(4); // A1, A2, B1, U1: what the Renewals page shows
    expect(await countMyRenewalsDue(s.admin.actor, 30, clock)).toBe(0);
  });
});
