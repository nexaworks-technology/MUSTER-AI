import type { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import {
  AccountNotFoundError,
  bookWhere,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { can } from "@/lib/auth/permissions";
import { parseMentions } from "./mentions";
import { createNoteInput } from "./schemas";

/**
 * Notes (spec §6F4): templates per call type, tags, @mentions → in-app notification. A mention
 * notifies only members who can see the account, so a notification never reveals an account
 * outside someone's book; the author is told who wasn't notified.
 */
export async function createNote(actor: Actor, raw: z.input<typeof createNoteInput>) {
  const input = createNoteInput.parse(raw);
  const account = await requireEditableAccount(actor, input.accountId);
  const db = scopedDb(actor);
  const members = await db.membership.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      role: true,
      bookScope: true,
      canViewRevenue: true,
      user: { select: { name: true, email: true } },
    },
  });
  const named = members.map((m) => ({ membershipId: m.id, name: m.user.name ?? m.user.email }));
  const mentioned = parseMentions(input.body, named).filter((id) => id !== actor.membershipId);
  // Who among the mentioned can actually see this account (same rule as the Accounts list).
  const visible = new Set<string>();
  for (const id of mentioned) {
    const m = members.find((x) => x.id === id)!;
    const grant = can(m, "accounts:view");
    if (!grant) continue;
    const scoped = await db.account.count({
      where: { AND: [{ id: account.id }, bookWhere({ membershipId: id }, grant.scope)] },
    });
    if (scoped > 0) visible.add(id);
  }
  const author = named.find((n) => n.membershipId === actor.membershipId)?.name ?? "Someone";
  const note = await db.$tenantTransaction(async (tx) => {
    const created = await tx.note.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        authorMembershipId: actor.membershipId,
        templateId: input.templateId ?? null,
        body: input.body,
        tags: input.tags,
        mentionMembershipIds: [...visible],
        origin: "HUMAN",
      },
    });
    for (const recipient of visible) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspaceId,
          recipientMembershipId: recipient,
          type: "MENTION",
          title: `${author} mentioned you in a note on ${account.name}`,
          refType: "Note",
          refId: created.id,
          accountId: account.id,
        },
      });
    }
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "note.created",
        targetType: "Note",
        targetId: created.id,
        summary: `Added a note on ${account.name}`,
        after: { tags: input.tags, mentioned: [...visible] },
      },
      tx,
    );
    return created;
  });
  const notNotified = mentioned
    .filter((id) => !visible.has(id))
    .map((id) => named.find((n) => n.membershipId === id)!.name);
  return { note, notified: visible.size, notNotified };
}

export async function listNotes(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  return scopedDb(actor).note.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 100,
    include: {
      author: { select: { user: { select: { name: true, email: true } } } },
      template: { select: { name: true } },
    },
  });
}

export async function listNoteTemplates(actor: Actor) {
  return scopedDb(actor).noteTemplate.findMany({ orderBy: { name: "asc" } });
}

/** Notes added. */
export async function noteTimeline(
  db: ScopedDb,
  accountId: string,
  upTo: Date,
  take: number,
): Promise<TimelineItem[]> {
  const notes = await db.note.findMany({
    where: { accountId, createdAt: { lte: upTo } },
    orderBy: { createdAt: "desc" },
    take,
    include: { author: { select: { user: { select: { name: true } } } } },
  });
  return notes.map((n) => ({
    key: `note:${n.id}`,
    at: n.createdAt,
    kind: "note" as const,
    title: `Note by ${n.author?.user.name ?? "a former member"}`,
    detail: n.body.length > 160 ? `${n.body.slice(0, 157)}…` : n.body,
    href: `/accounts/${accountId}/notes`,
    sourceType: "Note",
    sourceId: n.id,
  }));
}
