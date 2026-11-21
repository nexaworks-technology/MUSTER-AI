import type { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import {
  AccountNotFoundError,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { ROLE_LABELS, type setChampionInput } from "./schemas";

/**
 * People & stakeholder map (spec §6A2). Roles keep their history (validFrom/validTo) so the M3
 * back-test can ask "who was champion on that date".
 */
export async function listPeople(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const db = scopedDb(actor);
  const [contacts, wrote] = await Promise.all([
    db.contact.findMany({
      where: { accountId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: { roles: { orderBy: { validFrom: "desc" } } },
    }),
    // The latest message each person sent us, from any source: the record Champion Guard reads
    // (DEMO-WALKTHROUGH FAIL 11). One statement whatever the number of people.
    db.message.findMany({
      where: { accountId, direction: "INBOUND", fromContactId: { not: null } },
      orderBy: [{ fromContactId: "asc" }, { sentAt: "desc" }, { id: "desc" }],
      distinct: ["fromContactId"],
      select: { id: true, fromContactId: true, sentAt: true, conversation: { select: { channel: true } } },
    }),
  ]);
  const latest = new Map(wrote.map((m) => [m.fromContactId!, m]));
  return contacts.map((c) => {
    const m = latest.get(c.id);
    // A date kept on the contact (by hand or a CRM) counts too, whichever is later.
    const lastContact =
      m && (!c.lastContactAt || m.sentAt >= c.lastContactAt)
        ? { at: m.sentAt, channel: m.conversation.channel, messageId: m.id }
        : c.lastContactAt
          ? { at: c.lastContactAt, channel: null, messageId: null }
          : null;
    return {
      ...c,
      lastContact,
      currentRoles: c.roles.filter((r) => r.validTo === null).map((r) => r.role),
      pastRoles: c.roles.filter((r) => r.validTo !== null),
    };
  });
}

/** Makes one contact the account's champion; the previous champion's role is closed, not deleted. */
export async function setChampion(
  actor: Actor,
  input: z.infer<typeof setChampionInput>,
): Promise<void> {
  await requireEditableAccount(actor, input.accountId);
  const now = new Date();
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    const contact = await tx.contact.findFirst({
      where: { id: input.contactId, accountId: input.accountId },
    });
    if (!contact) throw new AccountNotFoundError();
    const current = await tx.stakeholderRole.findMany({
      where: { accountId: input.accountId, role: "CHAMPION", validTo: null },
    });
    if (current.some((r) => r.contactId === contact.id)) return;
    await tx.stakeholderRole.updateMany({
      where: { id: { in: current.map((r) => r.id) } },
      data: { validTo: now },
    });
    await tx.stakeholderRole.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: input.accountId,
        contactId: contact.id,
        role: "CHAMPION",
        validFrom: now,
        setByMembershipId: actor.membershipId,
        origin: "HUMAN",
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "contact.champion_set",
        targetType: "Account",
        targetId: input.accountId,
        summary: `Made ${contact.name} the champion`,
        before: { championContactIds: current.map((r) => r.contactId) },
        after: { championContactId: contact.id },
      },
      tx,
    );
  });
}

// ─── Timeline source ─────────────────────────────────────────────────────────

/** Stakeholder role changes: a role starting or ending is a timeline event. */
export async function roleTimeline(
  db: ScopedDb,
  accountId: string,
  upTo: Date,
  take: number,
): Promise<TimelineItem[]> {
  const roles = await db.stakeholderRole.findMany({
    where: { accountId, OR: [{ validFrom: { lte: upTo } }, { validTo: { lte: upTo } }] },
    orderBy: { validFrom: "desc" },
    take,
    include: { contact: { select: { name: true } } },
  });
  return roles.flatMap((r) => {
    const items: TimelineItem[] = [
      {
        key: `role:${r.id}:from`,
        at: r.validFrom,
        kind: "people",
        title: `${r.contact.name} became ${ROLE_LABELS[r.role].toLowerCase()}`,
        sourceType: "StakeholderRole",
        sourceId: r.id,
      },
    ];
    if (r.validTo) {
      items.push({
        key: `role:${r.id}:to`,
        at: r.validTo,
        kind: "people",
        title: `${r.contact.name} is no longer ${ROLE_LABELS[r.role].toLowerCase()}`,
        sourceType: "StakeholderRole",
        sourceId: r.id,
      });
    }
    return items;
  });
}

export { championGuardFor, loadChampionGuard, type ChampionGuard } from "./champion-guard.service";
export { rankCandidates, type Candidate, type CandidatePerson } from "./champion-candidates";
