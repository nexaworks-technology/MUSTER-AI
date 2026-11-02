import type { ScopedDb } from "@/lib/db/scoped";
import { daysAgo } from "./dates";
import { ids } from "./ids";
import { createRng } from "./random";
import { ROSTER, type AccountSpec } from "./roster";

/** Accounts, contacts and stakeholder-role history (SEED_DATA §3). Upserts by stable id. */
export function contactEmail(account: AccountSpec, name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim()
    .replace(/\s+/g, ".")}@${account.domain}`;
}

export async function seedAccounts(db: ScopedDb, workspaceId: string): Promise<void> {
  const rng = createRng(7);
  for (const a of ROSTER) {
    const account = {
      name: a.name,
      domain: a.domain,
      tier: a.tier,
      tierSource: "RULE" as const,
      lifecycleStage: a.stage,
      onboardingStartedAt: a.onboardingDay !== undefined ? daysAgo(a.onboardingDay) : null,
      churnedAt: a.churnedDaysAgo !== undefined ? daysAgo(a.churnedDaysAgo) : null,
      ownerMembershipId: a.owner ? ids.membership(a.owner) : null,
      plan: a.plan,
      industry: a.industry,
      employeeBand: a.employeeBand,
      timezone: "America/New_York",
      source: "SEED" as const,
    };
    await db.account.upsert({
      where: { id: ids.account(a.key) },
      create: { id: ids.account(a.key), workspaceId, ...account },
      update: account,
    });
    for (const p of a.contacts) {
      const contactId = ids.contact(a.key, p.key);
      const contact = {
        accountId: ids.account(a.key),
        name: p.name,
        email: p.email ?? contactEmail(a, p.name),
        title: p.title,
        status: p.status ?? "ACTIVE",
        statusChangedAt: p.statusDaysAgo !== undefined ? daysAgo(p.statusDaysAgo) : null,
        externalUserId: `${a.key}:${p.key}`,
        lastContactAt: p.key === "maya" ? daysAgo(44) : daysAgo(rng.int(2, 40)),
        source: "SEED" as const,
      };
      await db.contact.upsert({
        where: { id: contactId },
        create: { id: contactId, workspaceId, ...contact },
        update: contact,
      });
      for (const [i, r] of p.roles.entries()) {
        const roleId = `${contactId}r${i}`;
        const role = {
          accountId: ids.account(a.key),
          contactId,
          role: r.role,
          validFrom: daysAgo(r.fromDaysAgo),
          validTo: r.toDaysAgo !== undefined ? daysAgo(r.toDaysAgo) : null,
          origin: "HUMAN" as const,
        };
        await db.stakeholderRole.upsert({
          where: { id: roleId },
          create: { id: roleId, workspaceId, ...role },
          update: role,
        });
      }
    }
  }
}
