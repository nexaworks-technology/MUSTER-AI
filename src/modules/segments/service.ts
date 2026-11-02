import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { can, ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { minorDigits } from "@/lib/money";
import type { Actor } from "@/modules/accounts/service";
import { compileSegment, segmentFilter, type SegmentFilter } from "./dsl";

export { segmentFilter, SegmentPermissionError } from "./dsl";
export type { SegmentFilter } from "./dsl";

/** Saved segments (spec §6F5). Shared across the workspace; evaluated per member's book. */
export const createSegmentInput = z.object({
  name: z.string().trim().min(1, "Name the segment").max(80),
  filter: segmentFilter,
});

export class SegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentError";
  }
}

export async function createSegment(actor: Actor, raw: z.input<typeof createSegmentInput>) {
  requirePermission(actor, "accounts:edit");
  const input = createSegmentInput.parse(raw);
  await segmentWhereFor(actor, input.filter); // refuses ARR filters without revenue access
  const db = scopedDb(actor);
  if (await db.segment.findFirst({ where: { name: input.name } }))
    throw new SegmentError(`A segment called "${input.name}" already exists.`);
  return db.$tenantTransaction(async (tx) => {
    const segment = await tx.segment.create({
      data: {
        workspaceId: actor.workspaceId,
        name: input.name,
        filter: input.filter,
        createdByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "segment.created",
        targetType: "Segment",
        targetId: segment.id,
        summary: `Saved segment "${input.name}"`,
        after: { filter: input.filter },
      },
      tx,
    );
    return segment;
  });
}

export async function listSegments(actor: Actor) {
  requirePermission(actor, "accounts:view");
  const rows = await scopedDb(actor).segment.findMany({ orderBy: { name: "asc" } });
  // A stored filter that no longer validates is shown as unusable, never silently widened.
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    valid: segmentFilter.safeParse(s.filter).success,
  }));
}

export async function deleteSegment(actor: Actor, segmentId: string) {
  const db = scopedDb(actor);
  const segment = await db.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw new SegmentError("That segment was not found.");
  const mine = segment.createdByMembershipId === actor.membershipId;
  if (!mine && can(actor, "accounts:edit")?.scope !== "ALL")
    throw new ForbiddenError("accounts:edit");
  await db.$tenantTransaction(async (tx) => {
    await tx.segment.delete({ where: { id: segment.id } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "segment.deleted",
        targetType: "Segment",
        targetId: segment.id,
        summary: `Deleted segment "${segment.name}"`,
      },
      tx,
    );
  });
}

async function segmentWhereFor(actor: Actor, filter: SegmentFilter) {
  const workspace = await getOwnWorkspace(actor);
  return compileSegment(filter, {
    now: new Date(),
    arrScale: 10n ** BigInt(minorDigits(workspace.baseCurrency)),
    canViewRevenue: can(actor, "revenue:view") !== null,
  });
}

/** The compiled where for a saved segment (null if missing or invalid). Callers add book scope. */
export async function segmentWhere(actor: Actor, segmentId: string) {
  const segment = await scopedDb(actor).segment.findUnique({ where: { id: segmentId } });
  if (!segment) return null;
  const parsed = segmentFilter.safeParse(segment.filter);
  if (!parsed.success) return null;
  return { name: segment.name, where: await segmentWhereFor(actor, parsed.data) };
}

/** Turns the Accounts list's current filters into a segment filter ("Save as segment"). */
export function filterFromListQuery(q: {
  q?: string;
  tier?: string;
  stage?: string;
  owner?: string;
}): SegmentFilter | null {
  const all: unknown[] = [];
  if (q.q) all.push({ field: "name", op: "contains", value: q.q });
  if (q.tier) all.push({ field: "tier", op: "eq", value: q.tier });
  if (q.stage) all.push({ field: "lifecycleStage", op: "eq", value: q.stage });
  if (q.owner) all.push({ field: "owner", op: "eq", value: q.owner });
  if (all.length === 0) return null;
  return segmentFilter.parse({ all });
}
