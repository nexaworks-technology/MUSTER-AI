import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createRenewalBrief, getRenewalBrief, readDocument } from "@/modules/documents/service";
import { runSeed } from "../run";

/**
 * The Renewal Brief on the seed (M7 B3): Northgate Freight's brief carries locked figures read
 * from its own records (renewal 2026-12-13, confidence 70, health Healthy, the open WARN risks, no
 * goals, promise tracking not connected), each with its sources; without revenue access the
 * contract value is "Restricted".
 */
let ws: string;
const db = () => scopedDb({ workspaceId: ws });
const clock = () => new Date("2026-11-02T17:00:00Z");
const asActor = (m: { id: string }) =>
  ({ ...m, workspaceId: ws, membershipId: m.id }) as unknown as Actor;

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
}, 240_000);

describe("Northgate's renewal brief", () => {
  it("locks the figures from its own records, with sources", async () => {
    const admin = asActor(
      await db().membership.findFirstOrThrow({
        where: { role: "ADMIN", canViewRevenue: true, status: "ACTIVE" },
      }),
    );
    const north = await db().account.findFirstOrThrow({ where: { name: "Northgate Freight" } });
    const renewal = await db().renewal.findFirstOrThrow({
      where: { accountId: north.id, stage: "UPCOMING" },
    });
    await createRenewalBrief(admin, renewal.id, clock);
    const page = await getRenewalBrief(admin, renewal.id);
    const m = Object.fromEntries(page.document!.metrics.map((x) => [x.key, x]));
    expect(m["renewal.date"]!.text).toBe("Dec 13, 2026");
    expect(m["renewal.daysTo"]!.text).toBe("41 days");
    expect(m["renewal.confidence"]!.text).toBe("70%");
    expect(m["renewal.noticeDeadline"]!.text).toBe("Nov 13, 2026");
    expect(m["renewal.arr"]!.text).toBe("$142,000.00");
    expect(m["health.band"]!.text).toBe("Healthy");
    expect(m["risks.count"]!.text).toBe("6 open risk signals");
    expect(m["goals.status"]!.text).toBe("No goals on file");
    expect(m["promises.status"]!.text).toMatch(/1 promise made: 1 late, 0 open, 0 kept/);
    for (const k of ["renewal.date", "health.band", "risks.count"])
      expect(m[k]!.sources.length).toBeGreaterThan(0);
  });

  it("a member without revenue access sees the contract value as Restricted", async () => {
    const viewer = asActor(
      await db().membership.findFirstOrThrow({ where: { role: "ADMIN", status: "ACTIVE" } }),
    );
    const north = await db().account.findFirstOrThrow({ where: { name: "Northgate Freight" } });
    const renewal = await db().renewal.findFirstOrThrow({
      where: { accountId: north.id, stage: "UPCOMING" },
    });
    const doc = await db().document.findFirstOrThrow({ where: { id: renewal.briefDocumentId! } });
    const v = await readDocument({ ...viewer, canViewRevenue: false }, doc.id);
    expect(JSON.stringify(v)).not.toMatch(/142,000|14200000/);
    expect(v.metrics.find((x) => x.key === "renewal.arr")!.text).toBe("Restricted");
  });
});
