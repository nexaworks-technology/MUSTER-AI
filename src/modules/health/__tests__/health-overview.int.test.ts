import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { aggregate, type ComponentResults } from "../engine/aggregate";
import { DEFAULT_MODEL, PILLARS } from "../engine/model";
import { getActiveModel, healthOverview } from "../service";
import { writeSnapshot } from "../snapshots";

/** Health screen data (spec §5 Health, M3 rule 11): bands, movers with their reason, disagreements. */
let admin: Actor;
let csm: Actor;
const ONE = {
  ...DEFAULT_MODEL,
  componentConfig: Object.fromEntries(
    PILLARS.map((p) => [p, { main: { weight: 1 }, pulse: { weight: 1 } }]),
  ),
};
const agg = (score: number, pulse?: "FINE" | "WORRIED", pulseId = "p") =>
  aggregate(
    Object.fromEntries(
      PILLARS.map((p) => [
        p,
        {
          main:
            p === "SENTIMENT"
              ? {
                  score: null,
                  reason: {
                    component: "main",
                    kind: "MISSING_DATA" as const,
                    input: "x",
                    message: "none",
                    sources: [],
                  },
                }
              : {
                  score,
                  reason: {
                    component: "main",
                    kind: "EVIDENCE" as const,
                    input: "x",
                    message: `${p} at ${score}`,
                    sources: [{ sourceType: "Test", sourceId: p }],
                  },
                },
          ...(p === "RELATIONSHIP" && pulse
            ? {
                pulse: {
                  score: pulse === "FINE" ? 100 : 20,
                  reason: {
                    component: "pulse",
                    kind: "EVIDENCE" as const,
                    input: "csm_pulse",
                    message: pulse,
                    sources: [{ sourceType: "CsmPulse", sourceId: pulseId }],
                    pulseValue: pulse,
                  },
                },
              }
            : {}),
        },
      ]),
    ) as unknown as ComponentResults,
    ONE,
    "MID_TOUCH",
  );

beforeAll(async () => {
  admin = (await createTestAdmin("Overview")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const u = await db.user.create({ data: { email: `c-${ws}@example.test`, name: "C" } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: u.id, role: "CSM" } });
  csm = {
    ...admin,
    userId: u.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  const model = await getActiveModel(admin);
  const mk = async (
    name: string,
    owner: string | null,
    scores: Array<[string, ReturnType<typeof agg>]>,
  ) => {
    const a = await db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "MID_TOUCH",
        ownerMembershipId: owner,
        arrMinor: 1_000_000n,
        arrCurrency: "USD",
      },
    });
    for (const [asOf, score] of scores)
      await writeSnapshot(
        db,
        ws,
        {
          accountId: a.id,
          healthModelId: model.id,
          asOf,
          isBacktest: false,
          inputsHash: asOf,
          score,
        },
        { makeCurrent: true },
      );
    return a.id;
  };
  await mk("Fell today", m.id, [
    ["2026-10-26", agg(80)],
    ["2026-11-01", agg(80)],
    ["2026-11-02", agg(30)],
  ]);
  await mk("Fell this week", null, [
    ["2026-10-26", agg(80)],
    ["2026-11-01", agg(58)],
    ["2026-11-02", agg(57)],
  ]);
  const worried = await db.account.create({
    data: { workspaceId: ws, name: "Worried but healthy", tier: "MID_TOUCH" },
  });
  const p = await db.csmPulse.create({
    data: {
      workspaceId: ws,
      accountId: worried.id,
      membershipId: admin.membershipId,
      value: "WORRIED",
      expiresAt: new Date("2026-12-01"),
    },
  });
  await writeSnapshot(
    db,
    ws,
    {
      accountId: worried.id,
      healthModelId: model.id,
      asOf: "2026-11-02",
      isBacktest: false,
      inputsHash: "w",
      score: agg(90, "WORRIED", p.id),
    },
    { makeCurrent: true },
  );
});

describe("health overview", () => {
  it("counts bands, shows what moved and why, and lists disagreements", async () => {
    const o = await healthOverview(admin);
    expect(o.asOf).toBe("2026-11-02");
    expect(o.bands.AT_RISK.count).toBe(1);
    expect(o.bands.WATCH.count).toBe(1);
    expect(o.bands.HEALTHY.count).toBe(1);
    expect(o.bands.AT_RISK.arrMinor).toBe(1_000_000n);
    expect(o.movers.today.map((m) => m.name)).toEqual(["Fell today"]);
    expect(o.movers.today[0]).toMatchObject({
      from: { riskLevel: "HEALTHY" },
      to: { riskLevel: "AT_RISK" },
    });
    expect(o.movers.today[0]!.topReason).toMatch(/at 30$/);
    expect(o.movers.week.map((m) => m.name).sort()).toEqual(["Fell this week", "Fell today"]);
    expect(o.disagreements.map((d) => d.name)).toEqual(["Worried but healthy"]);
    expect(o.disagreements[0]).toMatchObject({ riskLevelExcludingPulse: "HEALTHY" });
  });

  it("a CSM sees only their book, and no money without revenue access", async () => {
    const o = await healthOverview(csm);
    expect(o.bands.AT_RISK.count + o.bands.WATCH.count + o.bands.HEALTHY.count).toBe(1);
    expect(o.bands.AT_RISK.arrMinor).toBeNull();
    expect(o.disagreements).toEqual([]);
  });
});
