import type { Prisma } from "@prisma/client";

/**
 * D-158: every reader of HealthScoreSnapshot that means "what the account's health is now" must
 * exclude back-test rows (isBacktest = true are replays, never live health). One helper so no
 * reader can forget; `extra` is merged in, but cannot switch the filter off.
 */
export function liveSnapshotWhere(
  extra: Prisma.HealthScoreSnapshotWhereInput = {},
): Prisma.HealthScoreSnapshotWhereInput {
  return { ...extra, isBacktest: false };
}
