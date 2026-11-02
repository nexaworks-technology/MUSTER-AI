import { Prisma } from "@prisma/client";
import { rawDb } from "../../src/lib/db/raw";

/**
 * Re-seeding keeps a false alarm suppressed (D-53), so the demo's "mark false alarm" step would
 * find nothing to mark on a re-run. Puts that one signal back to OPEN, as the seed left it.
 */
export async function reopenSignal(
  workspaceSlug: string,
  accountId: string,
  ruleKey: string,
): Promise<void> {
  const ws = await rawDb.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } });
  await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${ws.id}, true)`,
    rawDb.signal.updateMany({
      where: { workspaceId: ws.id, accountId, ruleKey, status: "FALSE_ALARM" },
      data: {
        status: "OPEN",
        markedFalseById: null,
        markedFalseAt: null,
        falseAlarmReason: null,
        falseAlarmValues: Prisma.DbNull,
      },
    }),
  ]);
}
