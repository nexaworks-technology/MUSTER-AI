import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";

/** In-app notifications for the signed-in member only (Slack deliveries are records, not bell items). */
export function unreadCount(actor: Actor): Promise<number> {
  return scopedDb(actor).notification.count({
    where: { recipientMembershipId: actor.membershipId, readAt: null, channel: "IN_APP" },
  });
}

export function listMyNotifications(actor: Actor) {
  return scopedDb(actor).notification.findMany({
    where: { recipientMembershipId: actor.membershipId, channel: "IN_APP" },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 50,
  });
}

export async function markAllRead(actor: Actor): Promise<number> {
  const { count } = await scopedDb(actor).notification.updateMany({
    where: { recipientMembershipId: actor.membershipId, readAt: null, channel: "IN_APP" },
    data: { readAt: new Date() },
  });
  return count;
}
