import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { recordProductEvent, safeProps } from "@/lib/pilot/capture";
import { listPilotRecords, loadPilotMetrics, pilotQuery } from "../pilot-report";

async function addMember(workspaceId: string, role: Role) {
  const id = randomUUID().slice(0, 8);
  const user = await rawDb.user.create({
    data: { email: `${role.toLowerCase()}-${id}@example.test`, name: `${role} ${id}` },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({ data: { workspaceId, userId: user.id, role, bookScope: "OWN" } });
  });
  return { workspaceId, membershipId: m.id, role: m.role, workspace: { timezone: "UTC" } };
}

describe("pilot capture", () => {
  it("writes workspace-scoped events and dedupes page views to one per member per 30 minutes", async () => {
    const { actor } = await createTestAdmin("pilot-cap");
    const other = await createTestAdmin("pilot-other");
    const t0 = new Date("2026-11-02T09:00:00Z");
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);

    expect(await recordProductEvent(actor, { name: "today.opened", at: t0 })).toBe(true);
    expect(await recordProductEvent(actor, { name: "today.opened", at: at(10) })).toBe(false);
    expect(await recordProductEvent(actor, { name: "today.opened", at: at(29) })).toBe(false);
    expect(await recordProductEvent(actor, { name: "today.opened", at: at(31) })).toBe(true);
    // a different page is its own stream; a different member is too
    expect(await recordProductEvent(actor, { name: "approvals.opened", at: at(5) })).toBe(true);
    expect(await recordProductEvent(other.actor, { name: "today.opened", at: at(5) })).toBe(true);
    // concurrent views by one member write once
    const racing = await Promise.all(
      [1, 2, 3].map(() => recordProductEvent(actor, { name: "approvals.opened", at: at(120) })),
    );
    expect(racing.filter(Boolean)).toHaveLength(1);
    // non-page events are never deduped
    expect(await recordProductEvent(actor, { name: "approval.decided", subjectId: "a1" })).toBe(
      true,
    );
    expect(await recordProductEvent(actor, { name: "approval.decided", subjectId: "a1" })).toBe(
      true,
    );

    const mine = await scopedDb(actor).productEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(mine.every((e) => e.workspaceId === actor.workspaceId)).toBe(true);
    expect(mine.filter((e) => e.name === "today.opened")).toHaveLength(2);
    expect(await scopedDb(other.actor).productEvent.count()).toBe(1);
  });

  it("never throws: no member, an unknown name, or a bad membership records nothing", async () => {
    const { actor } = await createTestAdmin("pilot-safe");
    expect(
      await recordProductEvent({ workspaceId: actor.workspaceId }, { name: "today.opened" }),
    ).toBe(false);
    expect(await recordProductEvent(actor, { name: "nope" as unknown as "today.opened" })).toBe(
      false,
    );
    expect(
      await recordProductEvent(
        { workspaceId: actor.workspaceId, membershipId: "not-a-member" },
        { name: "approval.decided" },
      ),
    ).toBe(false);
    expect(await scopedDb(actor).productEvent.count()).toBe(0);
  });

  it("props keep ids and small enums only: free text and objects are dropped", () => {
    expect(
      safeProps({
        kind: "SEND_EMAIL",
        n: 3,
        ok: true,
        body: "Dear customer, your renewal",
        nested: { a: 1 },
        long: "x".repeat(200),
      }),
    ).toEqual({ kind: "SEND_EMAIL", n: 3, ok: true });
  });
});

describe("pilot metrics report access", () => {
  it("is refused to a CSM and a Viewer, allowed to Admin and CS Leader, and computed from the workspace's events", async () => {
    const { actor, workspace } = await createTestAdmin("pilot-report");
    const csm = await addMember(workspace.id, "CSM");
    const viewer = await addMember(workspace.id, "VIEWER");
    const leader = await addMember(workspace.id, "CS_LEADER");
    const clock = () => new Date("2026-11-05T12:00:00Z");
    await recordProductEvent(csm, { name: "today.opened", at: new Date("2026-11-03T09:00:00Z") });
    await recordProductEvent(csm, {
      name: "signal.flag_accepted",
      subjectId: "s1",
      at: new Date("2026-11-03T10:00:00Z"),
    });

    const q = pilotQuery.parse({});
    await expect(loadPilotMetrics(csm, q, clock)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(loadPilotMetrics(viewer, q, clock)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPilotRecords(csm, ["x"])).rejects.toBeInstanceOf(ForbiddenError);

    for (const viewerOk of [leader, { ...actor, workspace: { timezone: "UTC" } }]) {
      const m = await loadPilotMetrics(viewerOk, q, clock);
      const row = m.members.find((x) => x.membershipId === csm.membershipId)!;
      expect(row.period.todayOpens.value).toBe(1);
      expect(row.period.flagAcceptance.value).toBe(100);
      expect(m.members.find((x) => x.membershipId === viewer.membershipId)).toBeUndefined();
      const recs = await listPilotRecords(viewerOk, row.period.todayOpens.sources.ids);
      expect(recs.rows.map((r) => r.id)).toEqual(row.period.todayOpens.sources.ids);
    }
  });

  it("another workspace's events never reach the report", async () => {
    const a = await createTestAdmin("pilot-iso-a");
    const b = await createTestAdmin("pilot-iso-b");
    await recordProductEvent(b.actor, {
      name: "today.opened",
      at: new Date("2026-11-03T09:00:00Z"),
    });
    const m = await loadPilotMetrics(
      { ...a.actor, workspace: { timezone: "UTC" } },
      pilotQuery.parse({}),
      () => new Date("2026-11-05T12:00:00Z"),
    );
    expect(m.members.every((x) => x.period.todayOpens.value === 0)).toBe(true);
  });
});
