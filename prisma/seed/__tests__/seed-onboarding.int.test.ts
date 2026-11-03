import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { getAccountOnboarding } from "@/modules/onboarding/service";
import { runSeed } from "../run";
import { ids } from "../demo/ids";

/**
 * Seed onboarding (SEED_DATA §7, M6): three templates; the eight onboarding accounts land in their
 * story states after the seed's own nightly pass (nothing in the seed writes a status or a
 * blocker); product-condition steps on open plans were completed by events with proof; time to
 * value cites real cohorts of completed plans.
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });
const clock = () => new Date("2026-11-02T17:00:00Z");

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 240_000);

const planOf = (key: string) =>
  db().onboardingPlan.findFirstOrThrow({
    where: {
      accountId: ids.account(key),
      status: { not: "CANCELLED" },
      startDate: { gt: new Date("2026-06-01") },
    },
    include: { steps: { orderBy: { position: "asc" } } },
  });

describe("seed — onboarding (SEED_DATA §7)", () => {
  it("has the three templates, each with a measurable value definition", async () => {
    const t = await db().onboardingTemplate.findMany({ orderBy: { name: "asc" } });
    expect(t.map((x) => x.name)).toEqual([
      "High-touch guided (90d)",
      "Long-tail self-serve (21d)",
      "Mid-touch standard (60d)",
    ]);
    for (const x of t) expect((x.valueDefinition as unknown[]).length).toBeGreaterThan(0);
  });

  it("lands the eight accounts in their story states", async () => {
    const state = async (key: string) => {
      const p = await planOf(key);
      return [p.status, p.stallReason];
    };
    expect(await state("pinecrest")).toEqual(["STALLED", "SSO setup (customer) overdue 12 days"]);
    expect(await state("wrenfield")).toEqual(["ACTIVE", null]);
    expect(await state("ostara")).toEqual([
      "STALLED",
      "Connect a data source (customer) overdue 19 days",
    ]);
    expect(await state("cobalt-ridge")).toEqual([
      "STALLED",
      "No one has used the product for 9 days",
    ]);
    expect((await state("juniper-vet"))[0]).toBe("COMPLETE");
    const lumen = await state("lumen");
    expect(lumen[0]).toBe("STALLED");
    expect(lumen[1]).toMatch(/^Day 75 and value not reached yet\./);
    expect(await state("saltmarsh")).toEqual(["ACTIVE", null]);
    expect(await state("ridgeback")).toEqual(["ACTIVE", null]);
    const ridgeback = await planOf("ridgeback");
    expect(ridgeback.steps.find((s) => s.key === "security_review")!.blockedReason).toBe(
      "waiting on legal review",
    );
  });

  it("product-condition steps on open plans were completed by events, with row ids as proof", async () => {
    const steps = await db().onboardingStep.findMany({
      where: {
        completesWhen: { not: undefined },
        doneAt: { not: null },
        plan: { status: { not: "COMPLETE" } },
      },
    });
    const withCondition = steps.filter((s) => s.completesWhen !== null);
    expect(withCondition.length).toBeGreaterThan(0);
    for (const s of withCondition) {
      expect(s.completedVia).toBe("PRODUCT_EVENT");
      expect((s.evidence as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("Juniper Vet reached value on day 37 (found by the nightly pass), faster than the cohort median of 52", async () => {
    const priya = await db().membership.findUniqueOrThrow({
      where: { id: ids.membership("priya") },
    });
    const v = await getAccountOnboarding(
      { ...priya, workspaceId: ws, membershipId: priya.id },
      ids.account("juniper-vet"),
      clock,
    );
    expect(v.ttv).toMatchObject({ state: "REACHED", days: 37, verdict: "ON_TIME" });
    expect(v.ttv!.cohort).toMatchObject({ medianDays: 52, fellBack: false });
    // The proof is real rows: every cited usage id exists for this account.
    const proof = v.plan!.valueEvidence as Array<{ sourceType: string; sourceId: string }>;
    expect(proof.length).toBeGreaterThan(0);
    const ud = proof.filter((p) => p.sourceType === "UsageDaily").map((p) => p.sourceId);
    const fud = proof.filter((p) => p.sourceType === "FeatureUsageDaily").map((p) => p.sourceId);
    expect(ud.length + fud.length).toBe(proof.length);
    const juniper = ids.account("juniper-vet");
    expect(await db().usageDaily.count({ where: { id: { in: ud }, accountId: juniper } })).toBe(
      ud.length,
    );
    expect(
      await db().featureUsageDaily.count({ where: { id: { in: fud }, accountId: juniper } }),
    ).toBe(fud.length);
  });

  it("Saltmarsh's handoff shows its two stated goals with their sources", async () => {
    const goals = await db().goal.findMany({ where: { accountId: ids.account("saltmarsh") } });
    expect(goals).toHaveLength(2);
    for (const g of goals) expect(g.sourceId).toBe(ids.account("saltmarsh"));
  });

  it("re-seeding changes no onboarding row (idempotent)", async () => {
    const snap = async () =>
      JSON.stringify(
        await db().onboardingPlan.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            status: true,
            stallReason: true,
            valueReachedAt: true,
            steps: {
              orderBy: { id: "asc" },
              select: { id: true, doneAt: true, completedVia: true },
            },
          },
        }),
      );
    const before = await snap();
    await runSeed({ includeTestTenant: false });
    expect(await snap()).toBe(before);
  }, 240_000);
});
