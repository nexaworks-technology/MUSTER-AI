import type { ScopedDb } from "@/lib/db/scoped";

/** Shared by the M6 agents that draft to a customer contact: who, and who decides inside. */

/** The preferred contact if they can receive email, else a champion, else any active contact with an email. */
export async function firstEmailContact(
  db: ScopedDb,
  accountId: string,
  preferredId: string | null,
) {
  const where = { accountId, email: { not: null }, status: "ACTIVE" as const };
  if (preferredId) {
    const preferred = await db.contact.findFirst({ where: { ...where, id: preferredId } });
    if (preferred) return preferred;
  }
  const champion = await db.stakeholderRole.findFirst({
    where: { accountId, role: "CHAMPION", validTo: null, contact: { is: { ...where } } },
    include: { contact: true },
    orderBy: { validFrom: "desc" },
  });
  if (champion) return champion.contact;
  return db.contact.findFirst({ where, orderBy: { createdAt: "asc" } });
}

/** The first CS Leader, else Admin: who an unowned account's internal work goes to. */
export async function fallbackLeader(db: ScopedDb): Promise<string | null> {
  for (const role of ["CS_LEADER", "ADMIN"] as const) {
    const m = await db.membership.findFirst({
      where: { role, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (m) return m.id;
  }
  return null;
}
