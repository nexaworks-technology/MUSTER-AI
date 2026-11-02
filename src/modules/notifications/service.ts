import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";

/** In-app notifications for the signed-in member only. */
export function unreadCount(actor: Actor): Promise<number> {
  return scopedDb(actor).notification.count({
    where: { recipientMembershipId: actor.membershipId, readAt: null },
  });
}

export function listMyNotifications(actor: Actor) {
  return scopedDb(actor).notification.findMany({
    where: { recipientMembershipId: actor.membershipId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 50,
  });
}

export async function markAllRead(actor: Actor): Promise<number> {
  const { count } = await scopedDb(actor).notification.updateMany({
    where: { recipientMembershipId: actor.membershipId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}
