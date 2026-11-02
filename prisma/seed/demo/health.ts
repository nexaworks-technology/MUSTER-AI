import type { ScopedDb } from "@/lib/db/scoped";
import { getActiveModel } from "@/modules/health/service";
import { insertOutsideSignal, runNightlyInline, syncSignalRules } from "@/modules/signals/service";
import { daysAgo, SEED_TODAY } from "./dates";
import { ids, seedId } from "./ids";

/**
 * Seed v2 (M3): CSM Pulses (SEED_DATA §3), the Brightwell outside signal (CSV row in SEED_DATA §3),
 * then the nightly pipeline for SEED_TODAY so the demo opens with snapshots and signals.
 */
const PULSES = [
  { key: "tidewater", by: "leo", value: "WORRIED", comment: "New VP is skeptical", daysAgo: 2 },
  {
    key: "ashgrove",
    by: "aisha",
    value: "FINE",
    comment: "Spike was one migration, resolved",
    daysAgo: 1,
  },
] as const;

export async function seedHealth(db: ScopedDb, workspaceId: string): Promise<void> {
  for (const p of PULSES) {
    const id = seedId(`pulse:${p.key}`);
    const data = {
      accountId: ids.account(p.key),
      membershipId: ids.membership(p.by),
      value: p.value,
      comment: p.comment,
      createdAt: daysAgo(p.daysAgo),
      expiresAt: new Date(daysAgo(p.daysAgo).getTime() + 30 * 86_400_000),
    };
    await db.csmPulse.upsert({ where: { id }, create: { id, workspaceId, ...data }, update: data });
  }

  await syncSignalRules({ workspaceId });
  const rule = await db.signalRule.findFirstOrThrow({ where: { ruleKey: "outside_event" } });
  await db.$tenantTransaction((tx) =>
    insertOutsideSignal(
      tx,
      workspaceId,
      {
        accountId: ids.account("brightwell"),
        kind: "ACQUISITION",
        headline: "Acquired by Haverford Group",
        sourceUrl: "https://news.example.test/haverford-brightwell",
        eventDate: "2026-10-20",
      },
      {
        origin: "IMPORT",
        createdByMembershipId: ids.membership("priya"),
        today: SEED_TODAY,
        now: daysAgo(0),
        ruleVersion: rule.version,
      },
    ),
  );

  await getActiveModel({ workspaceId });
  await runNightlyInline({ workspaceId }, SEED_TODAY, () => daysAgo(0));
}
