import type { Prisma, TodayItemType } from "@prisma/client";
import {
  addDays,
  calendarDateOf,
  localDate,
  startOfLocalDay,
  businessClock,
  todayIn,
  utcMidnight,
  type Clock,
} from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import type { Actor } from "@/modules/accounts/service";
import { rankItems, type Candidate, type Reason } from "./ranking";

/**
 * Today (spec §5, §6F1; ARCHITECTURE §9): "What needs me today?" for one member, ranked by money
 * × urgency. Only the member's own accounts and work: tasks they own (and overdue tasks escalated
 * to them), new signals and renewals on accounts they own, approvals assigned to them. TodayItem
 * is a rebuildable cache: rebuilt when older than STALE_MINUTES, and by the hourly job.
 */
export const SECTIONS = [
  { key: "TASK", label: "Tasks due or overdue" },
  { key: "SIGNAL", label: "New signals" },
  { key: "MEETING", label: "Meetings" },
  { key: "APPROVAL", label: "Approvals waiting" },
  { key: "RENEWAL", label: "Renewals in the next 90 days" },
] as const satisfies ReadonlyArray<{ key: TodayItemType; label: string }>;

export const PAGE_SIZE = 25;
const STALE_MINUTES = 10;

type Member = Pick<Actor, "workspaceId" | "membershipId" | "bookScope" | "canViewRevenue">;

/** "My accounts": owned by me; with TEAM scope also the unowned pool (D-41). Leaders included. */
const myAccounts = (m: Member): Prisma.AccountWhereInput =>
  m.bookScope === "TEAM"
    ? {
        OR: [{ ownerMembershipId: m.membershipId }, { ownerMembershipId: null }],
        lifecycleStage: { not: "LOST" },
      }
    : { ownerMembershipId: m.membershipId, lifecycleStage: { not: "LOST" } };

const accountSelect = {
  id: true,
  name: true,
  arrMinor: true,
  arrCurrency: true,
  renewalDate: true,
} as const;

export async function todayCandidates(
  m: Member,
  clock: Clock = businessClock,
): Promise<Candidate[]> {
  const ctx: TenantContext = { workspaceId: m.workspaceId };
  const db = scopedDb(ctx);
  const ws = await getOwnWorkspace(ctx);
  const tz = ws.timezone;
  const now = clock();
  const today = todayIn(tz, clock);
  // Due before tomorrow starts in the workspace time zone (D-50): today and anything overdue.
  const endOfToday = startOfLocalDay(addDays(today, 1), tz);
  const [tasks, escalated, signals, approvals, renewals] = await Promise.all([
    db.task.findMany({
      where: {
        ownerMembershipId: m.membershipId,
        status: "OPEN",
        dueAt: { not: null, lt: endOfToday },
      },
      include: { account: { select: accountSelect } },
    }),
    db.notification.findMany({
      where: { recipientMembershipId: m.membershipId, type: "TASK_OVERDUE", refType: "Task" },
      select: { refId: true },
    }),
    db.signal.findMany({
      where: { status: "OPEN", severity: { in: ["WARN", "CRITICAL"] }, account: myAccounts(m) },
      include: { account: { select: accountSelect } },
    }),
    db.approval.findMany({
      where: { status: "PENDING", assigneeId: m.membershipId },
      include: { account: { select: accountSelect } },
    }),
    db.account.findMany({
      where: {
        ...myAccounts(m),
        renewalDate: { gte: utcMidnight(today), lte: utcMidnight(addDays(today, 90)) },
      },
      select: accountSelect,
    }),
  ]);
  const escalatedTasks = escalated.length
    ? await db.task.findMany({
        where: {
          id: { in: escalated.map((e) => e.refId) },
          status: "OPEN",
          ownerMembershipId: { not: m.membershipId },
        },
        include: {
          account: { select: accountSelect },
          owner: { include: { user: { select: { name: true } } } },
        },
      })
    : [];
  const acct = (
    a: {
      id: string;
      name: string;
      arrMinor: bigint | null;
      arrCurrency: string | null;
      renewalDate: Date | null;
    } | null,
  ) => ({
    accountId: a?.id ?? null,
    accountName: a?.name ?? null,
    arrMinor: a?.arrMinor ?? null,
    currency: a?.arrCurrency ?? ws.baseCurrency,
    renewalDate: a?.renewalDate ? calendarDateOf(a.renewalDate) : null,
  });
  return [
    ...tasks.map((t): Candidate => ({
      itemType: "TASK",
      refId: t.id,
      title: t.title,
      ...acct(t.account),
      dueAt: t.dueAt,
      driver: { kind: "TASK_DUE", dueDate: localDate(t.dueAt!, tz) },
    })),
    ...escalatedTasks
      .filter((t) => t.dueAt)
      .map((t): Candidate => ({
        itemType: "TASK",
        refId: t.id,
        title: t.title,
        ...acct(t.account),
        dueAt: t.dueAt,
        driver: {
          kind: "ESCALATED_TASK",
          dueDate: localDate(t.dueAt!, tz),
          ownerName: t.owner.user.name ?? "a CSM",
        },
      })),
    ...signals.map((s): Candidate => ({
      itemType: "SIGNAL",
      refId: s.id,
      title: s.title,
      ...acct(s.account),
      driver: { kind: "SIGNAL", severity: s.severity },
    })),
    ...approvals.map((a): Candidate => ({
      itemType: "APPROVAL",
      refId: a.id,
      title: a.reason,
      ...acct(a.account),
      driver: { kind: "APPROVAL", waitingHours: (+now - +a.createdAt) / 3_600_000 },
    })),
    ...renewals.map((a): Candidate => ({
      itemType: "RENEWAL",
      refId: a.id,
      title: `${a.name} renews`,
      ...acct(a),
      driver: { kind: "RENEWAL", renewalDate: calendarDateOf(a.renewalDate!) },
    })),
  ];
}

/** Replaces one member's Today items with a fresh ranking (idempotent). */
export async function rebuildToday(m: Member, clock: Clock = businessClock) {
  const ctx: TenantContext = { workspaceId: m.workspaceId };
  const ws = await getOwnWorkspace(ctx);
  const ranked = rankItems(await todayCandidates(m, clock), {
    today: todayIn(ws.timezone, clock),
    canViewRevenue: m.canViewRevenue,
  });
  const computedAt = clock();
  await scopedDb(ctx).$tenantTransaction(async (tx) => {
    await tx.todayItem.deleteMany({ where: { membershipId: m.membershipId } });
    if (ranked.length)
      await tx.todayItem.createMany({
        data: ranked.map((r) => ({
          workspaceId: m.workspaceId,
          membershipId: m.membershipId,
          itemType: r.itemType,
          refId: r.refId,
          accountId: r.accountId,
          title: r.title,
          rankScore: r.rankScore,
          rankReasons: r.rankReasons as unknown as Prisma.InputJsonValue,
          dueAt: r.dueAt ?? null,
          computedAt,
        })),
      });
  });
  return ranked.length;
}

export interface TodaySection {
  key: TodayItemType;
  label: string;
  total: number;
  cursor: number;
  next: number | null;
  items: Array<{
    id: string;
    itemType: TodayItemType;
    refId: string;
    title: string;
    accountId: string | null;
    accountName: string | null;
    reasons: Reason[];
    rankScore: number;
  }>;
}

/** The member's Today, section by section, 25 per page; rebuilt first when stale. */
export async function getToday(
  m: Member,
  opts: { cursors?: Partial<Record<TodayItemType, number>>; clock?: Clock } = {},
): Promise<TodaySection[]> {
  const clock = opts.clock ?? businessClock;
  const db = scopedDb({ workspaceId: m.workspaceId });
  const latest = await db.todayItem.findFirst({
    where: { membershipId: m.membershipId },
    orderBy: { computedAt: "desc" },
    select: { computedAt: true },
  });
  if (!latest || +clock() - +latest.computedAt > STALE_MINUTES * 60_000)
    await rebuildToday(m, clock);
  const names = new Map<string, string>();
  const sections = await Promise.all(
    SECTIONS.map(async (s): Promise<TodaySection> => {
      const cursor = opts.cursors?.[s.key] ?? 0;
      const where = { membershipId: m.membershipId, itemType: s.key };
      const [rows, total] = await Promise.all([
        db.todayItem.findMany({
          where,
          orderBy: [{ rankScore: "desc" }, { title: "asc" }],
          skip: cursor,
          take: PAGE_SIZE,
          include: { account: { select: { name: true } } },
        }),
        db.todayItem.count({ where }),
      ]);
      for (const r of rows) if (r.account) names.set(r.accountId!, r.account.name);
      return {
        key: s.key,
        label: s.label,
        total,
        cursor,
        next: cursor + PAGE_SIZE < total ? cursor + PAGE_SIZE : null,
        items: rows.map((r) => ({
          id: r.id,
          itemType: r.itemType,
          refId: r.refId,
          title: r.title,
          accountId: r.accountId,
          accountName: r.account?.name ?? null,
          reasons: r.rankReasons as unknown as Reason[],
          rankScore: r.rankScore,
        })),
      };
    }),
  );
  return sections;
}

/** The hourly job: every active member of a workspace. */
export async function rebuildWorkspaceToday(ctx: TenantContext, clock: Clock = businessClock) {
  const members = await scopedDb(ctx).membership.findMany({
    where: { status: "ACTIVE" },
    select: { workspaceId: true, id: true, bookScope: true, canViewRevenue: true },
  });
  for (const mem of members)
    await rebuildToday(
      {
        workspaceId: mem.workspaceId,
        membershipId: mem.id,
        bookScope: mem.bookScope,
        canViewRevenue: mem.canViewRevenue,
      },
      clock,
    );
  return members.length;
}

export {
  rankItems,
  moneyWeight,
  urgencyOf,
  type Candidate,
  type Ranked,
  type Reason,
} from "./ranking";
