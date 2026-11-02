import { can } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";
import { billingTimeline } from "@/modules/billing/service";
import { roleTimeline } from "@/modules/contacts/service";
import { conversationTimeline } from "@/modules/conversations/service";
import { noteTimeline } from "@/modules/notes/service";
import { ticketTimeline } from "@/modules/support/service";
import { taskTimeline } from "@/modules/tasks/service";
import { usageTimeline } from "@/modules/usage/service";
import { decodeCursor, mergeTimeline } from "@/modules/accounts/schemas";

/**
 * The Account 360 timeline: one access check, then every registered source in parallel, merged
 * by the pure keyset merge (DECISIONS D-44). M3 adds signals/health, M4 agent actions, M10 meetings.
 */
export const TIMELINE_PAGE = 30;
/** Each source fetches a little more than a page so ties at the cursor are never lost. */
const SOURCE_TAKE = TIMELINE_PAGE + 50;

export async function getTimeline(actor: Actor, accountId: string, rawCursor?: string | null) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  const upTo = cursor?.at ?? new Date();
  const db = scopedDb(actor);
  const moneyVisible = can(actor, "revenue:view") !== null;
  const sources: TimelineItem[][] = await Promise.all([
    conversationTimeline(db, accountId, upTo, SOURCE_TAKE),
    ticketTimeline(db, accountId, upTo, SOURCE_TAKE),
    billingTimeline(db, accountId, upTo, SOURCE_TAKE, moneyVisible),
    usageTimeline(db, actor.workspaceId, accountId, upTo),
    noteTimeline(db, accountId, upTo, SOURCE_TAKE),
    taskTimeline(db, accountId, upTo, SOURCE_TAKE),
    roleTimeline(db, accountId, upTo, SOURCE_TAKE),
  ]);
  return mergeTimeline(sources, cursor, TIMELINE_PAGE);
}
