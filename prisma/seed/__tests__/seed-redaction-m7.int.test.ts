import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { getAccountRenewals, listRenewals } from "@/modules/renewals/service";
import { getRevenueView } from "@/modules/revenue/service";
import { countQueries } from "@/test/query-counter";
import { runSeed } from "../run";

/**
 * M7 money redaction (spec §6N5, rule 8), enumerated: every M7 read model, as a member without
 * revenue access, carries no money key and no figure that exists in the contract records; as a
 * member with it, the same reads do. The /revenue view refuses outright. Query counts do not grow
 * with the number of rows. (Lives with the seed tests because it needs the seeded renewals.)
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });
const clock = () => new Date("2026-11-02T17:00:00Z");
const MONEY_KEY = /arr|amount|currency|minor|value|price|revenue/i;

const asActor = (m: { id: string }) =>
  ({ ...m, workspaceId: ws, membershipId: m.id }) as unknown as Actor;
const actorFor = async (role: "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER", revenue: boolean) =>
  asActor(
    await db().membership.findFirstOrThrow({
      where: { role, canViewRevenue: revenue, status: "ACTIVE" },
    }),
  );

function keysOf(v: unknown, path = "", out: string[] = []): string[] {
  if (v === null || typeof v !== "object") return out;
  if (v instanceof Date) return out;
  if (Array.isArray(v)) {
    v.forEach((x, i) => keysOf(x, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    out.push(`${path}.${k}`);
    keysOf(x, `${path}.${k}`, out);
  }
  return out;
}
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 240_000);

describe("M7 reads without revenue access", () => {
  it("the renewal list and account renewal view carry no money key and no contract figure", async () => {
    // A member without revenue access whose book has renewals (a CSM's book may be empty).
    const members = await db().membership.findMany({
      where: { canViewRevenue: false, status: "ACTIVE" },
      orderBy: { id: "asc" },
    });
    let csm: Actor | null = null;
    let list: Awaited<ReturnType<typeof listRenewals>> | null = null;
    for (const m of members) {
      const a = asActor(m);
      const l = await listRenewals(a, { days: 365 }, clock).catch(() => null);
      if (l && l.rows.length > 0) {
        csm = a;
        list = l;
        break;
      }
    }
    expect(list, "a member without revenue access sees renewals").not.toBeNull();
    const accountId = list!.rows[0]!.account.id;
    const tab = await getAccountRenewals(csm!, accountId, clock);
    const contracts = await db().contract.findMany({
      where: { valueMinor: { not: null } },
      select: { valueMinor: true },
    });
    const figures = [...new Set(contracts.map((c) => String(c.valueMinor)))].filter(
      (s) => s.length >= 5,
    );
    for (const [label, payload] of [
      ["list", list],
      ["tab", tab.open],
    ] as const) {
      const offending = keysOf(payload).filter(
        (k) => MONEY_KEY.test(k.split(".").at(-1)!) && !k.endsWith(".moneyVisible"),
      );
      // `reasons[].reason` text is prose, but must not hold a contract figure either.
      expect(offending, `${label} money keys`).toEqual([]);
      const text = json(payload);
      for (const f of figures) expect(text, `${label} figure ${f}`).not.toContain(f);
      expect(text).not.toMatch(/[$£€]\s?\d/);
    }
  });

  it("the same reads carry money for a member with revenue access", async () => {
    const admin = await actorFor("ADMIN", true);
    const list = await listRenewals(admin, { days: 365 }, clock);
    expect(list.rows.some((r) => typeof r.arrMinor === "bigint")).toBe(true);
    expect(list.forecast).not.toBeNull();
  });

  it("/revenue refuses every role without revenue access", async () => {
    for (const role of ["ADMIN", "CS_LEADER", "CSM", "VIEWER"] as const) {
      const m = await db().membership.findFirst({
        where: { role, canViewRevenue: false, status: "ACTIVE" },
      });
      if (!m) continue;
      await expect(getRevenueView(asActor(m), {}, clock)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("/revenue works for a viewer who has been given revenue access", async () => {
    const admin = await actorFor("ADMIN", true);
    const v = await getRevenueView(admin, {}, clock);
    expect(v.waterfall.base.reconciled).toBe(true);
    expect(v.atRisk.map((r) => r.windowDays)).toEqual([30, 90]);
  });
});

describe("M7 read query budgets", () => {
  it("listRenewals and getRevenueView use a fixed number of queries whatever the row count", async () => {
    const admin = await actorFor("ADMIN", true);
    await listRenewals(admin, { days: 30 }, clock); // warm
    const few = await countQueries(() => listRenewals(admin, { days: 30 }, clock));
    const many = await countQueries(() => listRenewals(admin, { days: 365 }, clock));
    expect(many.result.rows.length).toBeGreaterThan(few.result.rows.length);
    expect(many.queries).toBe(few.queries);
    expect(many.queries).toBeLessThanOrEqual(8);
    const rev = await countQueries(() => getRevenueView(admin, {}, clock));
    expect(rev.queries).toBeLessThanOrEqual(10);
  });
});
