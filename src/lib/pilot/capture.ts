import type { Prisma } from "@prisma/client";
import { businessClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { logger } from "@/lib/logger";
import {
  isProductEventName,
  PAGE_VIEW_DEDUPE_MINUTES,
  PAGE_VIEW_EVENTS,
  type ProductEventName,
} from "./events";

/**
 * Pilot instrumentation capture (M12 B5). Server-side only. Recording an event can never
 * fail or slow the thing the member is doing: every error is logged and swallowed. A caller with
 * no membership (a worker, the system) records nothing, because the pilot judges people.
 */
export interface EventActor {
  workspaceId: string;
  membershipId?: string | null;
}

export interface EventInput {
  name: ProductEventName;
  subjectType?: string;
  subjectId?: string;
  /** Ids and small enums only; anything else is dropped before it is stored. */
  props?: Record<string, unknown>;
  at?: Date;
}

const MAX_PROP = 64;

/** Keeps booleans, numbers and short strings. Long text is dropped: no customer content here. */
export function safeProps(props: Record<string, unknown> | undefined): Prisma.InputJsonObject {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string" && v.length <= MAX_PROP && !/\s/.test(v)) out[k] = v;
  }
  return out;
}

/** True when an event was written; false when skipped (no member, duplicate view) or failed. */
export async function recordProductEvent(actor: EventActor, input: EventInput): Promise<boolean> {
  try {
    if (!actor.membershipId || !isProductEventName(input.name)) return false;
    const membershipId = actor.membershipId;
    const at = input.at ?? businessClock();
    const dedupe = PAGE_VIEW_EVENTS.includes(input.name);
    return await scopedDb({ workspaceId: actor.workspaceId }).$tenantTransaction(async (tx) => {
      if (dedupe) {
        // Serialize concurrent views by the same member (a row lock on their membership; it does
        // not block anyone else's foreign-key checks) so two tabs cannot both write.
        await tx.$queryRaw`SELECT id FROM "Membership" WHERE "workspaceId" = ${actor.workspaceId} AND id = ${membershipId} FOR NO KEY UPDATE`;
        const since = new Date(at.getTime() - PAGE_VIEW_DEDUPE_MINUTES * 60_000);
        const recent = await tx.productEvent.findFirst({
          where: {
            workspaceId: actor.workspaceId,
            membershipId,
            name: input.name,
            occurredAt: { gt: since },
          },
          select: { id: true },
        });
        if (recent) return false;
      }
      await tx.productEvent.create({
        data: {
          workspaceId: actor.workspaceId,
          membershipId,
          name: input.name,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          occurredAt: at,
          props: safeProps(input.props),
        },
      });
      return true;
    });
  } catch (err) {
    logger.warn(
      { err, event: input.name, workspaceId: actor.workspaceId },
      "pilot event not recorded",
    );
    return false;
  }
}
