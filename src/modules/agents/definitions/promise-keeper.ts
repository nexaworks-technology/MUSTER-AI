import { z } from "zod";
import { addDays, businessClock, calendarDateOf, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { defineAgent } from "../define";
import { runAgent, type ExecutorDeps } from "../executor";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { fallbackLeader } from "./draft-support";

/**
 * Promise Keeper (spec §6E7, M9 B3): for one late promise of ours, an internal chase Task. The
 * model suggests who should own it and what the chase should say; code decides the owner (a member
 * of this workspace, else the account's owner, else a leader), the due date (tomorrow) and the title.
 * It never contacts the customer: no Approval, no OutboundMessage. Internal Tasks need no approval
 * (Q-65). One chase task per promise, ever.
 */
export const promiseKeeperOutput = z.object({
  ...baseAgentOutput.shape,
  ownerMembershipId: z.string().min(1).nullable(),
  chaseDetail: z.string().min(1).max(400),
});
export type PromiseKeeperOutput = z.infer<typeof promiseKeeperOutput>;

export const promiseKeeperInput = z.object({ promiseId: z.string().min(1) });

export const chaseTitle = (what: string) => `Chase late promise: ${what}`.slice(0, 200);

export const promiseKeeper = defineAgent({
  key: "promise-keeper",
  version: "1.0.0",
  description:
    "For a late promise of ours, makes one internal chase task with a suggested owner; never contacts the customer",
  modelTier: "fast",
  tierReason: "Narrow, internal, short output: who and what to chase (§6.1).",
  prompt: { name: "promise-keeper", version: "1.0.0" },
  inputSchema: promiseKeeperInput,
  outputSchema: promiseKeeperOutput,
  async buildContext(db, input) {
    const p = await db.promise.findUnique({
      where: { id: input.promiseId },
      include: { account: { select: { id: true, name: true } } },
    });
    if (!p) return { bundle: [] as ContextBundle, vars: { accountName: "the account" } };
    const members = await db.membership.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { id: "asc" },
      take: 50,
    });
    const bundle: ContextBundle = [
      {
        sourceType: "Promise",
        sourceId: p.id,
        fields: {
          what: p.what,
          dueDate: p.dueDate ? calendarDateOf(p.dueDate) : null,
          status: p.status.toLowerCase(),
          reason: p.statusReason,
          quote: p.quote,
        },
      },
      { sourceType: "Account", sourceId: p.account.id, fields: { name: p.account.name } },
      ...members.map((m) => ({
        sourceType: "Member" as const,
        sourceId: m.id,
        fields: { name: m.user.name ?? m.user.email, role: m.role.toLowerCase() },
      })),
    ];
    return { bundle, accountId: p.account.id, vars: { accountName: p.account.name } };
  },
  narrative: (o) => [o.chaseDetail],
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: "INTERNAL",
  async act(output, ctx) {
    const promiseId = (ctx.input as z.infer<typeof promiseKeeperInput>).promiseId;
    const db = ctx.db;
    const p = await db.promise.findUnique({ where: { id: promiseId } });
    if (!p || p.party !== "US" || (p.status !== "LATE" && p.status !== "BROKEN"))
      return { effects: [], actionTaken: "NONE" };
    const title = chaseTitle(p.what);
    const existing = await db.task.findFirst({
      where: { accountId: p.accountId, title },
      select: { id: true },
    });
    if (existing) return { effects: [], actionTaken: "NONE" };

    // Code decides: a member the model named (active, in this workspace), else the promise's own
    // owner, else the account's owner, else a leader.
    const named = output.ownerMembershipId
      ? await db.membership.findFirst({
          where: { id: output.ownerMembershipId, status: "ACTIVE" },
          select: { id: true },
        })
      : null;
    const account = await db.account.findUnique({
      where: { id: p.accountId },
      select: { ownerMembershipId: true },
    });
    const owner =
      named?.id ?? p.ownerMembershipId ?? account?.ownerMembershipId ?? (await fallbackLeader(db));
    if (!owner) return { effects: [], actionTaken: "NONE" };
    const ws = await getOwnWorkspace({ workspaceId: ctx.workspaceId });
    const due = addDays(todayIn(ws.timezone, businessClock), 1);
    const signal = await db.signal.findFirst({
      where: { accountId: p.accountId, dedupeKey: `promise_late:${p.accountId}:${p.id}` },
      select: { id: true },
    });
    const task = await db.task.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: p.accountId,
        signalId: signal?.id ?? null,
        title,
        detail: `${output.chaseDetail}\n\nPromised: “${p.quote ?? p.what}”. ${p.statusReason}`,
        ownerMembershipId: owner,
        dueAt: new Date(`${due}T00:00:00Z`),
        priority: p.status === "BROKEN" ? "HIGH" : "NORMAL",
        origin: "AI",
        agentRunId: ctx.runId,
        source: "SYSTEM",
      },
    });
    return { effects: [{ type: "Task", id: task.id }], actionTaken: "TASK_CREATED" };
  },
});

/** Every late promise of ours with no chase task yet: ask once each (a few per pass). */
export async function sweepPromiseKeeper(
  ctx: TenantContext,
  deps: ExecutorDeps & { clock?: Clock } = {},
  limit = 10,
) {
  const db = scopedDb(ctx);
  const late = await db.promise.findMany({
    where: { party: "US", status: { in: ["LATE", "BROKEN"] } },
    select: { id: true, accountId: true, what: true },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: 200,
  });
  if (late.length === 0) return { notConfigured: false as const, asked: 0 };
  const tasks = await db.task.findMany({
    where: {
      title: { in: late.map((p) => chaseTitle(p.what)) },
      accountId: { in: late.map((p) => p.accountId) },
    },
    select: { accountId: true, title: true },
  });
  const have = new Set(tasks.map((t) => `${t.accountId}:${t.title}`));
  const todo = late
    .filter((p) => !have.has(`${p.accountId}:${chaseTitle(p.what)}`))
    .slice(0, limit);
  let asked = 0;
  for (const p of todo) {
    const r = await runAgent(
      ctx,
      promiseKeeper,
      { promiseId: p.id },
      { type: "promise", id: p.id },
      deps,
    );
    if (r.kind === "not_configured")
      return { notConfigured: true as const, reason: r.reason, asked };
    asked++;
  }
  return { notConfigured: false as const, asked };
}
