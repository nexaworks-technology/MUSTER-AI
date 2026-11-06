/**
 * `NODE_ENV=test pnpm exec tsx --env-file=.env scripts/perf-pages.ts --workspace scale-test`
 * (M12 B3, measurement tooling). Times each big list's page 1, page 2 and last page and each list's
 * SQL statement count against the generated scale workspace, as its admin and (for the tasks
 * queue) one CSM. Timings are for THIS machine, never staging. NODE_ENV=test turns on the Prisma
 * query events the counter reads.
 */
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { countQueries } from "@/test/query-counter";
import { listAccounts } from "@/modules/accounts/service";
import { accountListQuery } from "@/modules/accounts/schemas";
import { listSignals } from "@/modules/signals/service";
import { listMyTasks } from "@/modules/tasks/service";
import { listRenewals } from "@/modules/renewals/service";
import { listOpportunities } from "@/modules/expansion/service";
import { listApprovals } from "@/modules/approvals/service";
import { listInbox } from "@/modules/inbox/service";
import { listPromises } from "@/modules/promises/service";
import { getToday } from "@/modules/today/service";
import { healthOverview } from "@/modules/health/service";

async function actorFor(workspaceId: string, role: "ADMIN" | "CSM") {
  const m = await scopedDb({ workspaceId }).membership.findFirstOrThrow({
    where: { role },
    include: { user: true },
    orderBy: { id: "asc" },
  });
  return {
    workspaceId,
    userId: m.userId,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
    user: { id: m.user.id, email: m.user.email, name: m.user.name },
  };
}

async function main() {
  const slug = process.argv[process.argv.indexOf("--workspace") + 1] ?? "scale-test";
  const ws = (await findWorkspaceBySlug(slug))!;
  const admin = await actorFor(ws.id, "ADMIN");
  const csm = await actorFor(ws.id, "CSM");
  const lines: string[] = [];
  const run = async (name: string, label: string, fn: () => Promise<unknown>) => {
    const t = performance.now();
    const { queries } = await countQueries(fn);
    lines.push(
      `${name.padEnd(28)} ${label.padEnd(10)} ${(performance.now() - t).toFixed(0).padStart(6)} ms  ${String(queries).padStart(3)} queries`,
    );
  };
  // Warm the connection and plan caches so page 1 is not charged for them.
  await listAccounts(admin, accountListQuery.parse({}));

  const total = (await listAccounts(admin, accountListQuery.parse({}))).total ?? 2000;
  await run("accounts (offset cursor)", "page 1", () =>
    listAccounts(admin, accountListQuery.parse({})),
  );
  await run("accounts (offset cursor)", "page 2", () =>
    listAccounts(admin, accountListQuery.parse({ cursor: "50" })),
  );
  await run("accounts (offset cursor)", "last page", () =>
    listAccounts(
      admin,
      accountListQuery.parse({ cursor: String(Math.floor((total - 1) / 50) * 50) }),
    ),
  );
  await run("accounts sorted by ARR", "page 2", () =>
    listAccounts(admin, accountListQuery.parse({ sort: "arr", cursor: "50" })),
  );
  const sig = await listSignals(admin, {} as never);
  await run("signals (offset cursor)", "page 1", () => listSignals(admin, {} as never));
  await run("signals (offset cursor)", "page 2", () =>
    listSignals(admin, { cursor: sig.nextCursor ?? 0 } as never),
  );
  await run("signals (offset cursor)", "deep", () =>
    listSignals(admin, { cursor: Math.max(0, sig.total - 25) } as never),
  );
  await run("renewals (page n)", "page 1", () => listRenewals(admin, { days: 365, page: 1 }));
  await run("renewals (page n)", "page 2", () => listRenewals(admin, { days: 365, page: 2 }));
  await run("expansion (page n)", "page 1", () =>
    listOpportunities(admin, { status: "ALL", page: 1 }),
  );
  await run("expansion (page n)", "page 2", () =>
    listOpportunities(admin, { status: "ALL", page: 2 }),
  );
  await run("approvals (offset)", "page 1", () => listApprovals(admin, {}));
  await run("approvals (offset)", "page 2", () => listApprovals(admin, { cursor: 25 }));
  const inb = await listInbox(admin, { status: "ALL" });
  await run("inbox (keyset cursor)", "page 1", () => listInbox(admin, { status: "ALL" }));
  await run("inbox (keyset cursor)", "page 2", () =>
    listInbox(admin, { status: "ALL", ...(inb.nextCursor ? { cursor: inb.nextCursor } : {}) }),
  );
  await run("promises", "page 1", () => listPromises(admin, {}));
  await run("tasks (take 100, no cursor)", "CSM open", () => listMyTasks(csm, "OPEN"));
  await run("today", "page 1", () => getToday(admin, {}));
  await run("health overview", "-", () => healthOverview(admin));
  console.log(lines.join("\n"));
  console.log(`(accounts total ${total}; signals total ${sig.total})`);
}
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  },
);
