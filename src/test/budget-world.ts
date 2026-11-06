import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { businessClock } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { rebuildWorkspaceToday } from "@/modules/today/service";
import { runNightlyInline } from "@/modules/signals/service";
import { generateScale } from "../../prisma/seed/scale";
import { countQueries as countAll } from "./query-counter";

/**
 * Test support for the M12 query-budget files: a small synthetic workspace built by the scale
 * generator (so it has the same shapes as the 2,000-account one), run through the real nightly
 * pass and a Today rebuild. `small` is a CSM who owns 2 accounts, `big` a CSM who owns 5, so a
 * list loader's statement count can be compared at 2 rows and at 5 (no N+1: the counts are equal).
 * Synthetic data lives only in tests and seeds (Rule 6).
 */
export const AS_OF = "2026-11-02";
export const clock = () => new Date("2026-11-02T14:00:00.000Z");
type Role = "ADMIN" | "CSM";

async function actorOf(workspaceId: string, membershipId: string) {
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    const m = await tx.membership.findUniqueOrThrow({
      where: { id: membershipId },
      include: { user: true },
    });
    return {
      workspaceId,
      userId: m.userId,
      membershipId: m.id,
      role: m.role as Role,
      canViewRevenue: m.canViewRevenue,
      bookScope: m.bookScope,
      user: { id: m.user.id, email: m.user.email, name: m.user.name },
    };
  });
}

export async function budgetWorld() {
  const slug = `qb-${randomUUID().slice(0, 8)}`;
  const gen = await generateScale({ accounts: 12, slug, reset: false, dense: true });
  const ctx = { workspaceId: gen.workspaceId };
  const db = scopedDb(ctx);
  const id = (k: string) => `${gen.workspaceId}-m-${k}`;
  // 12 accounts are dealt round-robin to csm1..csm6 (2 each). Move csm3's and one of csm4's to
  // csm2 so csm2 owns 5 and csm1 owns 2.
  const toMove = await db.account.findMany({
    where: { ownerMembershipId: { in: [id("csm3"), id("csm4")] } },
    orderBy: { id: "asc" },
    select: { id: true, ownerMembershipId: true },
  });
  const moving = [
    ...toMove.filter((a) => a.ownerMembershipId === id("csm3")),
    ...toMove.filter((a) => a.ownerMembershipId === id("csm4")).slice(0, 1),
  ];
  await db.account.updateMany({
    where: { id: { in: moving.map((a) => a.id) } },
    data: { ownerMembershipId: id("csm2") },
  });
  for (const t of ["task", "approval", "promise"] as const) {
    const d = db as unknown as Record<string, { updateMany: (a: unknown) => Promise<unknown> }>;
    const ownerField = t === "approval" ? "assigneeId" : "ownerMembershipId";
    await d[t]!.updateMany({
      where: { accountId: { in: moving.map((a) => a.id) } },
      data: { [ownerField]: id("csm2") },
    });
  }
  await runNightlyInline(ctx, AS_OF, clock);
  await rebuildWorkspaceToday(ctx, clock);
  const [admin, small, big] = await Promise.all([
    actorOf(gen.workspaceId, id("admin")),
    actorOf(gen.workspaceId, id("csm1")),
    actorOf(gen.workspaceId, id("csm2")),
  ]);
  const [smallAccounts, bigAccounts] = await Promise.all([
    db.account.findMany({
      where: { ownerMembershipId: small.membershipId },
      orderBy: { id: "asc" },
      select: { id: true },
    }),
    db.account.findMany({
      where: { ownerMembershipId: big.membershipId },
      orderBy: { id: "asc" },
      select: { id: true },
    }),
  ]);
  return {
    ctx,
    db,
    admin,
    small,
    big,
    smallAccounts: smallAccounts.map((a) => a.id),
    bigAccounts: bigAccounts.map((a) => a.id),
    businessClock,
  };
}

/** The statement count of `fn` for the 2-account CSM and for the 5-account CSM. */
export async function twoVsFive<T>(
  w: Awaited<ReturnType<typeof budgetWorld>>,
  count: <R>(fn: () => Promise<R>) => Promise<{ result: R; queries: number }>,
  load: (actor: typeof w.small, accountIds: string[]) => Promise<T>,
) {
  const two = await count(() => load(w.small, w.smallAccounts));
  const five = await count(() => load(w.big, w.bigAccounts));
  return { two, five };
}

/**
 * No N+1: a loader's statement count may differ by a statement or two between datasets (a relation
 * read only runs when there are rows to attach it to, and which relations a page has depends on
 * its data), but never grows with the row count. With 3 more rows (2 vs 5) or 4 more (adding
 * rows), a per-row read would add at least 3, so a slack of 2 catches it.
 */
export function expectBounded(a: number, b: number, slack = 2): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(slack);
}

/**
 * The M12 budget tests' statement count: `countQueries` minus Prisma's own pool-validation pings
 * (a bare `SELECT 1` when a fresh connection opens). Under parallel load one can fall inside the
 * counting window, which made a count flicker by one; it is not a statement the loader sent.
 */
export async function countQueries<T>(fn: () => Promise<T>) {
  const r = await countAll(fn);
  const statements = r.statements.filter((q) => !/^SELECT 1\s*$/i.test(q.trim()));
  return { result: r.result, queries: statements.length, statements };
}
