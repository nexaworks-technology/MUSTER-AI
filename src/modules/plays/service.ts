import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { playDefinitionSchema, type PlayDefinition } from "./definition";
import { validatePlaySafety, type SafetyCheckResult } from "./safety";

export class PlayNotFoundError extends Error {
  constructor(message = "Play not found") {
    super(message);
    this.name = "PlayNotFoundError";
  }
}

export type PublishResult =
  | { status: "PUBLISHED"; playId: string; versionId: string; version: number }
  | { status: "REFUSED"; refusals: string[]; stepRefusals?: Record<string, string[]> };

export async function publishPlay(
  actor: Actor,
  playId: string,
  opts: { retroactive?: boolean } = {},
): Promise<PublishResult> {
  requirePermission(actor, "plays:publish");
  const db = scopedDb(actor);

  const play = await db.play.findUnique({
    where: { id: playId },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!play) throw new PlayNotFoundError();

  const latestVersion = play.versions[0];
  if (!latestVersion) {
    throw new Error("Play has no versions to publish.");
  }

  const def = playDefinitionSchema.parse(latestVersion.definition);

  const safety = await validatePlaySafety(def, {
    resolveSegment: async (segmentId) => {
      const seg = await db.segment.findUnique({ where: { id: segmentId } });
      return seg ? { id: seg.id, filter: seg.filter } : null;
    },
  });

  if (!safety.passed) {
    // Save the safety check results; play remains DRAFT
    await db.playVersion.update({
      where: { id: latestVersion.id },
      data: { safetyCheck: { passed: false, refusals: safety.refusals } },
    });
    return {
      status: "REFUSED",
      refusals: safety.refusals,
      stepRefusals: safety.stepRefusals,
    };
  }

  // Publish succeeded
  const now = new Date();
  await db.$tenantTransaction(async (tx) => {
    await tx.playVersion.update({
      where: { id: latestVersion.id },
      data: {
        publishedById: actor.membershipId,
        publishedAt: now,
        safetyCheck: { passed: true, refusals: [] },
      },
    });

    await tx.play.update({
      where: { id: play.id },
      data: {
        status: "PUBLISHED",
        currentVersionId: latestVersion.id,
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "play.published",
        targetType: "Play",
        targetId: play.id,
        summary: `Published play "${play.name}" v${latestVersion.version}`,
        after: {
          version: latestVersion.version,
          playVersionId: latestVersion.id,
          retroactive: Boolean(opts.retroactive),
        },
      },
      tx,
    );
  });

  return {
    status: "PUBLISHED",
    playId: play.id,
    versionId: latestVersion.id,
    version: latestVersion.version,
  };
}
