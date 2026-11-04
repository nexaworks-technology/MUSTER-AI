import type { Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";
import { SEEDED_PLAYS } from "./definitions";

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
      select: { key: true },
    });
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
