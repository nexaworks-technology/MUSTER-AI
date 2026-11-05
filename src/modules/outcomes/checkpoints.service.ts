import { Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import {
  addDays,
  businessClock,
  calendarDateOf,
  localDate,
  startOfLocalDay,
  todayIn,
  type Clock,
} from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { liveSnapshotWhere } from "@/modules/health/service";
import {
  CHECKPOINT_DAYS,
  CHECKPOINT_GRACE_DAYS,
  checkpointDue,
  classifyAlarm,
  decideCheckpoint,
  type CheckpointDay,
  type LongCheckpoint,
  type RevenueEventFact,
} from "./checkpoints";

const DAY = 86_400_000;
/** How far before the earliest flag to look for "the health band at the flag". */
const SNAPSHOT_LOOKBACK_DAYS = 120;

/**
 * M11 S2: evaluate every due 30/90-day checkpoint for one workspace and store each result ONCE
 * (D-161; the `outcome_checkpoint_frozen` trigger refuses any rewrite). Due dates are business
 * dates in the workspace time zone from `businessClock`, evaluated `CHECKPOINT_GRACE_DAYS` after
 * the checkpoint date. At d90, the alarm class (D-163) is frozen too when it is determined.
 * Loads facts in a fixed number of queries for all due records; one transaction per stored
 * checkpoint (with an audit row). Idempotent: a stored checkpoint is never evaluated again.
 */
export async function evaluateLongCheckpoints(
  ctx: TenantContext & { timezone: string },
  clock: Clock = businessClock,
) {
  const db = scopedDb(ctx);
  const tz = ctx.timezone;
  const now = clock();
  const today = todayIn(tz, () => now);
  const minAge = 30 + CHECKPOINT_GRACE_DAYS - 1; // a day of slack for time-zone edges
  const candidates = await db.outcomeRecord.findMany({
    where: {
      flaggedAt: { lte: new Date(+now - minAge * DAY) },
      OR: [{ d30Outcome: { equals: Prisma.DbNull } }, { d90Outcome: { equals: Prisma.DbNull } }],
    },
    orderBy: { flaggedAt: "asc" },
  });

  type Job = { record: (typeof candidates)[number]; day: CheckpointDay; dueOn: string };
  const jobs: Job[] = [];
  for (const r of candidates) {
    const flaggedOn = localDate(r.flaggedAt, tz);
    for (const day of CHECKPOINT_DAYS) {
      const stored = day === 30 ? r.d30Outcome : r.d90Outcome;
      if (stored !== null) continue;
      const { dueOn, due } = checkpointDue(flaggedOn, day, today);
      if (due) jobs.push({ record: r, day, dueOn });
    }
  }
  if (jobs.length === 0) return { evaluated: 0, counts: {} as Record<string, number> };

  const accountIds = [...new Set(jobs.map((j) => j.record.accountId))];
  const signalIds = [
    ...new Set(jobs.flatMap((j) => (j.record.signalId ? [j.record.signalId] : []))),
  ];
  const earliest = new Date(Math.min(...jobs.map((j) => +j.record.flaggedAt)));
  const latestDue = jobs
    .map((j) => j.dueOn)
    .sort()
    .at(-1)!;
  const windowCap = startOfLocalDay(addDays(latestDue, 1), tz);
  const fromDay = new Date(calendarDateOf(earliest));

  const [messages, meetings, snapshots, outcomes, events, signals] = await Promise.all([
    db.message.findMany({
      where: {
        accountId: { in: accountIds },
        direction: "INBOUND",
        sentAt: { gt: earliest, lt: windowCap },
      },
      select: { id: true, accountId: true, sentAt: true },
    }),
    db.meeting.findMany({
      where: {
        accountId: { in: accountIds },
        status: "COMPLETED",
        startsAt: { gt: earliest, lt: windowCap },
      },
      select: { id: true, accountId: true, startsAt: true },
    }),
    db.healthScoreSnapshot.findMany({
      where: liveSnapshotWhere({
        accountId: { in: accountIds },
        asOf: {
          gte: new Date(+fromDay - SNAPSHOT_LOOKBACK_DAYS * DAY),
          lte: new Date(latestDue),
        },
      }),
      select: { id: true, accountId: true, asOf: true, riskLevel: true, createdAt: true },
      orderBy: [{ asOf: "asc" }, { createdAt: "asc" }],
    }),
    db.renewalOutcome.findMany({
      where: { accountId: { in: accountIds }, occurredOn: { gte: fromDay } },
      select: { id: true, accountId: true, result: true, occurredOn: true, supersedesId: true },
    }),
    db.revenueEvent.findMany({
      where: {
        accountId: { in: accountIds },
        type: { in: ["EXPANSION", "CONTRACTION", "CHURN"] },
        effectiveDate: { gte: fromDay },
      },
      select: { id: true, accountId: true, type: true, deltaArrMinor: true, effectiveDate: true },
    }),
    signalIds.length
      ? db.signal.findMany({ where: { id: { in: signalIds } }, select: { id: true, status: true } })
      : Promise.resolve([]),
  ]);
  // Several model versions may score the same day (D-62): the newest row of the day stands.
  const daySnaps = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) daySnaps.set(`${s.accountId}:${calendarDateOf(s.asOf)}`, s);
  const signalStatus = new Map(signals.map((s) => [s.id, s.status as string]));

  const counts: Record<string, number> = {};
  for (const { record: r, day, dueOn } of jobs) {
    const of = <T extends { accountId: string | null }>(xs: T[]) =>
      xs.filter((x) => x.accountId === r.accountId);
    const cp: LongCheckpoint = {
      ...decideCheckpoint({
        day,
        signalId: r.signalId,
        flagType: r.flagType,
        flaggedAt: r.flaggedAt,
        flaggedOn: localDate(r.flaggedAt, tz),
        dueOn,
        windowEnd: startOfLocalDay(addDays(dueOn, 1), tz),
        firstActionAt: r.firstActionAt,
        messages: of(messages).map((m) => ({ id: m.id, at: m.sentAt })),
        meetings: of(meetings).map((m) => ({ id: m.id, at: m.startsAt })),
        snapshots: [...daySnaps.values()]
          .filter((s) => s.accountId === r.accountId)
          .map((s) => ({ id: s.id, on: calendarDateOf(s.asOf), riskLevel: s.riskLevel })),
        renewalOutcomes: of(outcomes).map((o) => ({
          id: o.id,
          result: o.result,
          on: calendarDateOf(o.occurredOn),
          supersedesId: o.supersedesId,
        })),
        revenueEvents: of(events).map((e) => ({
          id: e.id,
          type: e.type as RevenueEventFact["type"],
          on: calendarDateOf(e.effectiveDate),
          deltaArrMinor: e.deltaArrMinor,
        })),
      }),
      evaluatedAt: now.toISOString(),
    };
    const alarm =
      day === 90
        ? classifyAlarm({
            flagType: r.flagType,
            signalStatus: r.signalId ? (signalStatus.get(r.signalId) ?? null) : null,
            d90: cp,
          })
        : null;
    await db.$tenantTransaction(async (tx) => {
      await tx.outcomeRecord.update({
        where: { id: r.id },
        data: {
          ...(day === 30
            ? { d30Outcome: cp as unknown as Prisma.InputJsonValue }
            : { d90Outcome: cp as unknown as Prisma.InputJsonValue }),
          ...(day === 90 && alarm !== null && r.isTrueAlarm === null ? { isTrueAlarm: alarm } : {}),
        },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "outcome.checkpoint",
          targetType: "OutcomeRecord",
          targetId: r.id,
          summary: `Day-${day} checkpoint: ${cp.status.toLowerCase().replace("_", " ")} (${cp.evidence.length} source${cp.evidence.length === 1 ? "" : "s"}, attributed, not causal)`,
          after: { day, status: cp.status, dueOn, isTrueAlarm: day === 90 ? alarm : undefined },
        },
        tx,
      );
    });
    const key = `d${day}:${cp.status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { evaluated: jobs.length, counts };
}
