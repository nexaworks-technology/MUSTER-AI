import type { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { scopedDb } from "@/lib/db/scoped";
import {
  AccountNotFoundError,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import type { setChampionInput } from "./schemas";

/**
 * People & stakeholder map (spec §6A2). Roles keep their history (validFrom/validTo) so the M3
 * back-test can ask "who was champion on that date".
 */
export async function listPeople(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const contacts = await scopedDb(actor).contact.findMany({
    where: { accountId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    include: { roles: { orderBy: { validFrom: "desc" } } },
  });
  return contacts.map((c) => ({
    ...c,
    currentRoles: c.roles.filter((r) => r.validTo === null).map((r) => r.role),
    pastRoles: c.roles.filter((r) => r.validTo !== null),
  }));
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
