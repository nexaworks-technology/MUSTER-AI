import type { Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";
import { SEEDED_PLAYS } from "./definitions";

const RELABELLED = new Set(["promise-late", "engagement-loss"]);

/**
 * Seeds the 15 default plays for a workspace (spec §5, §6I1, D9).
 * Idempotent: create-only, never overwrites existing user modifications.
 * Created as DRAFT with isSeeded=true.
 */
export async function seedPlaysForWorkspace(
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const run = async (db: Prisma.TransactionClient) => {
    const existing = await db.play.findMany({
      where: { workspaceId },
      select: { id: true, key: true, status: true, versions: { select: { id: true, version: true } } },
    });
    // M9: two seeded plays changed their label (Promise Late is live; Engagement Loss now says M10).
    // A workspace's edits are never overwritten: only a still-DRAFT play with its first version is relabelled.
    for (const p of SEEDED_PLAYS.filter((x) => RELABELLED.has(x.key))) {
      const row = existing.find((e) => e.key === p.key);
      const v1 = row?.versions.find((v) => v.version === 1);
      if (!row || row.status !== "DRAFT" || row.versions.length !== 1 || !v1) continue;
      await db.play.update({ where: { id: row.id }, data: { description: p.description } });
      await db.playVersion.update({
        where: { id: v1.id },
        data: { definition: p.definition as unknown as Prisma.InputJsonValue },
      });
    }
    const existingKeys = new Set(existing.map((p) => p.key));

    let created = 0;
    for (const p of SEEDED_PLAYS) {
      if (existingKeys.has(p.key)) continue;

      const play = await db.play.create({
        data: {
          workspaceId,
          key: p.key,
          name: p.name,
          description: p.description,
          category: p.category,
          status: "DRAFT",
          isSeeded: true,
        },
      });

      await db.playVersion.create({
        data: {
          workspaceId,
          playId: play.id,
          version: 1,
          definition: p.definition as unknown as Prisma.InputJsonValue,
        },
      });

      created++;
    }

    return created;
  };

  return tx ? run(tx) : scopedDb({ workspaceId }).$tenantTransaction(run);
}
