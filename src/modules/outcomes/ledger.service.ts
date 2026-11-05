import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { addDays, businessClock, todayIn, type CalendarDate, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { canSeeMoney } from "@/modules/billing/service";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { buildLedger, type Ledger, type LedgerD90, type LedgerRow } from "./ledger";

/**
 * M11 S3: loads the ledger's rows for the actor (workspace-scoped, book-scoped, `reports:view`)
 * in a fixed number of queries and hands them to the pure `buildLedger`. Also resolves one save
 * record with every link target (and says plainly when a target is gone).
 */
export const LEDGER_PERIOD_DAYS = [30, 90, 180, 365] as const;
export type LedgerPeriodDays = (typeof LEDGER_PERIOD_DAYS)[number];

/** Actor plus the workspace time zone (the workspace context carries it). */
export type LedgerActor = Actor & { workspace: { timezone: string } };

export interface LedgerQuery {
  period?: number;
  accountId?: string;
  playKey?: string;
  ruleKey?: string;
  /** A group key from the agent table: `agent:<key>` or `rule:<key>`. */
  agentKey?: string;
}

export interface LedgerView {
  ledger: Ledger;
  periodDays: LedgerPeriodDays;
  accountNames: Record<string, string>;
  playNames: Record<string, string>;
}

const d90Schema = z.object({
  status: z.string(),
  actionTaken: z.enum(["ACTED", "IGNORED"]),
  dueOn: z.string(),
  evidence: z.array(z.object({ sourceType: z.string(), sourceId: z.string() })).default([]),
});
const refsSchema = z.array(
  z.object({
    type: z.enum(["Approval", "OutboundMessage", "Task", "PlayStep"]),
    id: z.string(),
  }),
);

export const parseD90 = (json: unknown): LedgerD90 | null => {
  const p = d90Schema.safeParse(json);
  return p.success ? p.data : null;
};
export const parseRefs = (json: unknown) => {
  const p = refsSchema.safeParse(json);
  return p.success ? p.data : [];
};

export const periodDays = (n: number | undefined): LedgerPeriodDays =>
  (LEDGER_PERIOD_DAYS as readonly number[]).includes(n ?? 0) ? (n as LedgerPeriodDays) : 90;

const SLACK_DAYS = 2;

export async function loadLedger(
  actor: LedgerActor,
  query: LedgerQuery = {},
  clock: Clock = businessClock,
): Promise<LedgerView> {
  const grant = requirePermission(actor, "reports:view");
  const db = scopedDb(actor);
  const days = periodDays(query.period);
  const to = todayIn(actor.workspace.timezone, clock);
  const from: CalendarDate = addDays(to, -days);
  // A day-90 due date inside the period means the flag happened 90 days earlier (+ slack for time
  // zones); flags with no day-90 yet are all later than that, so one window covers both.
  const flaggedSince = new Date(`${addDays(from, -90 - SLACK_DAYS)}T00:00:00Z`);

  const records = await db.outcomeRecord.findMany({
    where: {
      AND: [
        { flaggedAt: { gte: flaggedSince } },
        { account: bookWhere(actor, grant.scope) },
        ...(query.accountId ? [{ accountId: query.accountId }] : []),
      ],
    },
    select: {
      id: true,
      accountId: true,
      flagType: true,
      flaggedAt: true,
      arrAtFlagMinor: true,
      arrCurrency: true,
      signalId: true,
      actionRefs: true,
      d90Outcome: true,
      account: { select: { name: true } },
      signal: { select: { ruleKey: true } },
      agentRun: { select: { agentKey: true } },
    },
    orderBy: [{ flaggedAt: "desc" }, { id: "asc" }],
  });

  const parsed = records.map((r) => ({
    r,
    refs: parseRefs(r.actionRefs),
    d90: r.d90Outcome === null ? null : parseD90(r.d90Outcome),
  }));
  const ids = (type: string) => [
    ...new Set(parsed.flatMap((p) => p.refs.filter((x) => x.type === type).map((x) => x.id))),
  ];
  const revenueIds = [
    ...new Set(
      parsed.flatMap((p) =>
        p.r.flagType === "OPPORTUNITY" && p.d90
          ? p.d90.evidence.filter((e) => e.sourceType === "RevenueEvent").map((e) => e.sourceId)
          : [],
      ),
    ),
  ];
  const stepIds = ids("PlayStep");
  const approvalIds = ids("Approval");
  const taskIds = ids("Task");
  const messageIds = ids("OutboundMessage");

  const [stepRuns, events] = await Promise.all([
    db.playStepRun.findMany({
      where: {
        OR: [
          { id: { in: stepIds } },
          { approvalId: { in: approvalIds } },
          { taskId: { in: taskIds } },
          { outboundMessageId: { in: messageIds } },
        ],
      },
      select: {
        id: true,
        approvalId: true,
        taskId: true,
        outboundMessageId: true,
        createdAt: true,
        playRun: { select: { play: { select: { key: true, name: true } } } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.revenueEvent.findMany({
      where: { id: { in: revenueIds } },
      select: { id: true, deltaArrMinor: true, currency: true },
    }),
  ]);

  // The first play whose step ran any of the record's actions (earliest step run wins).
  const playNames: Record<string, string> = {};
  const playOf = (refs: ReturnType<typeof parseRefs>): string | null => {
    const mine = new Set(refs.map((x) => `${x.type}:${x.id}`));
    for (const s of stepRuns) {
      const hit =
        mine.has(`PlayStep:${s.id}`) ||
        (s.approvalId && mine.has(`Approval:${s.approvalId}`)) ||
        (s.taskId && mine.has(`Task:${s.taskId}`)) ||
        (s.outboundMessageId && mine.has(`OutboundMessage:${s.outboundMessageId}`));
      if (hit) {
        playNames[s.playRun.play.key] = s.playRun.play.name;
        return s.playRun.play.key;
      }
    }
    return null;
  };
  const eventById = new Map(events.map((e) => [e.id, e]));
  const accountNames: Record<string, string> = {};

  let rows: LedgerRow[] = parsed.map(({ r, refs, d90 }) => {
    accountNames[r.accountId] = r.account.name;
    return {
      id: r.id,
      accountId: r.accountId,
      flagType: r.flagType,
      flaggedAt: r.flaggedAt,
      arrAtFlagMinor: r.arrAtFlagMinor,
      arrCurrency: r.arrCurrency,
      signalId: r.signalId,
      ruleKey: r.signal?.ruleKey ?? null,
      agentKey: r.agentRun?.agentKey ?? null,
      playKey: playOf(refs),
      d90,
      expansionDeltas:
        r.flagType === "OPPORTUNITY" && d90
          ? d90.evidence.flatMap((e) => {
              const ev = e.sourceType === "RevenueEvent" ? eventById.get(e.sourceId) : undefined;
              return ev ? [{ currency: ev.currency, minor: ev.deltaArrMinor }] : [];
            })
          : [],
    };
  });
  if (query.playKey) rows = rows.filter((r) => (r.playKey ?? "none") === query.playKey);
  if (query.ruleKey) rows = rows.filter((r) => (r.ruleKey ?? "none") === query.ruleKey);
  if (query.agentKey)
    rows = rows.filter(
      (r) =>
        (r.agentKey ? `agent:${r.agentKey}` : r.ruleKey ? `rule:${r.ruleKey}` : "unknown") ===
        query.agentKey,
    );

  const ledger = buildLedger(rows, { from, to, canViewRevenue: canSeeMoney(actor) });
  return { ledger, periodDays: days, accountNames, playNames };
}

// ─── One save record ─────────────────────────────────────────────────────────

export interface LinkedItem {
  type: string;
  id: string;
  label: string;
  /** Null when no page shows it, or the record no longer exists (`note` says which). */
  href: string | null;
  note?: string;
}

export interface CheckpointView {
  day: 7 | 30 | 90;
  status: string;
  actionTaken: string | null;
  dueOn: string | null;
  detail: string | null;
  evidence: LinkedItem[];
}

export interface SaveRecordView {
  id: string;
  accountId: string;
  accountName: string;
  flagType: "RISK" | "OPPORTUNITY";
  flaggedAt: Date;
  actionTaken: string;
  signal: { id: string; title: string; ruleKey: string; href: string } | null;
  actions: LinkedItem[];
  checkpoints: CheckpointView[];
  moneyVisible: boolean;
  arrAtFlagMinor: bigint | null;
  arrCurrency: string | null;
  saved: boolean;
  valueSavedMinor: bigint | null;
}

const looseCheckpoint = z.object({
  status: z.string(),
  actionTaken: z.string().optional(),
  dueOn: z.string().optional(),
  detail: z.string().optional(),
  evidence: z.array(z.object({ sourceType: z.string(), sourceId: z.string() })).default([]),
});

export async function loadSaveRecord(
  actor: Actor,
  outcomeId: string,
): Promise<SaveRecordView | null> {
  const grant = requirePermission(actor, "reports:view");
  const db = scopedDb(actor);
  const r = await db.outcomeRecord.findFirst({
    where: { AND: [{ id: outcomeId }, { account: bookWhere(actor, grant.scope) }] },
    include: {
      account: { select: { name: true } },
      signal: { select: { id: true, title: true, ruleKey: true, accountId: true } },
    },
  });
  if (!r) return null;
  const refs = parseRefs(r.actionRefs);
  const cps = ([7, 30, 90] as const).flatMap((day) => {
    const raw = day === 7 ? r.d7Outcome : day === 30 ? r.d30Outcome : r.d90Outcome;
    const p = looseCheckpoint.safeParse(raw);
    return p.success ? [{ day, ...p.data }] : [];
  });
  const evid = (type: string) => [
    ...new Set(
      cps.flatMap((c) => c.evidence.filter((e) => e.sourceType === type).map((e) => e.sourceId)),
    ),
  ];
  const [
    approvals,
    messages,
    tasks,
    steps,
    renewalOutcomes,
    revenueEvents,
    inbound,
    meetings,
    snaps,
  ] = await Promise.all([
    db.approval.findMany({
      where: { id: { in: refs.filter((x) => x.type === "Approval").map((x) => x.id) } },
      select: { id: true, kind: true, status: true },
    }),
    db.outboundMessage.findMany({
      where: { id: { in: refs.filter((x) => x.type === "OutboundMessage").map((x) => x.id) } },
      select: { id: true, subject: true, status: true, approvalId: true },
    }),
    db.task.findMany({
      where: { id: { in: refs.filter((x) => x.type === "Task").map((x) => x.id) } },
      select: { id: true, title: true, status: true },
    }),
    db.playStepRun.findMany({
      where: { id: { in: refs.filter((x) => x.type === "PlayStep").map((x) => x.id) } },
      select: {
        id: true,
        stepKey: true,
        status: true,
        playRun: { select: { play: { select: { id: true, name: true } } } },
      },
    }),
    db.renewalOutcome.findMany({
      where: { id: { in: evid("RenewalOutcome") } },
      select: { id: true, result: true, occurredOn: true },
    }),
    db.revenueEvent.findMany({
      where: { id: { in: evid("RevenueEvent") } },
      select: { id: true, type: true },
    }),
    db.message.findMany({
      where: { id: { in: evid("Message") } },
      select: { id: true, subject: true },
    }),
    db.meeting.findMany({
      where: { id: { in: evid("Meeting") } },
      select: { id: true, title: true },
    }),
    db.healthScoreSnapshot.findMany({
      where: { id: { in: evid("HealthScoreSnapshot") }, isBacktest: false },
      select: { id: true, asOf: true, riskLevel: true },
    }),
  ]);
  const acct = `/accounts/${r.accountId}`;
  const gone = (type: string, id: string): LinkedItem => ({
    type,
    id,
    label: `${type} ${id}`,
    href: null,
    note: "This record no longer exists, so there is nothing to open.",
  });
  const actions: LinkedItem[] = refs.map((ref) => {
    if (ref.type === "Approval") {
      const a = approvals.find((x) => x.id === ref.id);
      return a
        ? {
            type: "Approval",
            id: a.id,
            label: `Approval (${a.kind}, ${a.status})`,
            href: `/approvals/${a.id}`,
          }
        : gone("Approval", ref.id);
    }
    if (ref.type === "OutboundMessage") {
      const m = messages.find((x) => x.id === ref.id);
      if (!m) return gone("Outbound message", ref.id);
      return {
        type: "OutboundMessage",
        id: m.id,
        label: `Message "${m.subject}" (${m.status})`,
        href: m.approvalId ? `/approvals/${m.approvalId}` : null,
        ...(m.approvalId
          ? {}
          : { note: "No approval is linked to this message, so no page shows it." }),
      };
    }
    if (ref.type === "Task") {
      const t = tasks.find((x) => x.id === ref.id);
      return t
        ? {
            type: "Task",
            id: t.id,
            label: `Task "${t.title}" (${t.status})`,
            href: `${acct}/tasks`,
          }
        : gone("Task", ref.id);
    }
    const s = steps.find((x) => x.id === ref.id);
    return s
      ? {
          type: "PlayStep",
          id: s.id,
          label: `Play "${s.playRun.play.name}", step ${s.stepKey} (${s.status})`,
          href: `/plays/${s.playRun.play.id}/results`,
        }
      : gone("Play step", ref.id);
  });
  const evidenceItem = (sourceType: string, sourceId: string): LinkedItem => {
    const base = { type: sourceType, id: sourceId };
    switch (sourceType) {
      case "RenewalOutcome": {
        const o = renewalOutcomes.find((x) => x.id === sourceId);
        return o
          ? {
              ...base,
              label: `Renewal outcome: ${o.result} on ${o.occurredOn.toISOString().slice(0, 10)}`,
              href: `${acct}/renewal`,
            }
          : gone(sourceType, sourceId);
      }
      case "RevenueEvent": {
        const e = revenueEvents.find((x) => x.id === sourceId);
        return e
          ? { ...base, label: `Revenue event: ${e.type}`, href: `${acct}/billing` }
          : gone(sourceType, sourceId);
      }
      case "Message": {
        const m = inbound.find((x) => x.id === sourceId);
        return m
          ? {
              ...base,
              label: `Message from the account${m.subject ? `: "${m.subject}"` : ""}`,
              href: `${acct}/conversations`,
            }
          : gone(sourceType, sourceId);
      }
      case "Meeting": {
        const m = meetings.find((x) => x.id === sourceId);
        return m
          ? {
              ...base,
              label: `Meeting "${m.title}"`,
              href: null,
              note: "No page shows individual meetings yet.",
            }
          : gone(sourceType, sourceId);
      }
      case "HealthScoreSnapshot": {
        const s = snaps.find((x) => x.id === sourceId);
        return s
          ? {
              ...base,
              label: `Health on ${s.asOf.toISOString().slice(0, 10)}: ${s.riskLevel}`,
              href: `${acct}/health`,
            }
          : gone(sourceType, sourceId);
      }
      default:
        return {
          ...base,
          label: `${sourceType} ${sourceId}`,
          href: null,
          note: "No page shows this kind of record.",
        };
    }
  };
  const d90 = parseD90(r.d90Outcome);
  const saved =
    r.flagType === "RISK" &&
    d90 !== null &&
    d90.actionTaken === "ACTED" &&
    (d90.status === "RECOVERED" || d90.status === "RENEWED");
  const visible = canSeeMoney(actor);
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.account.name,
    flagType: r.flagType,
    flaggedAt: r.flaggedAt,
    actionTaken: r.actionTaken,
    signal: r.signal
      ? {
          id: r.signal.id,
          title: r.signal.title,
          ruleKey: r.signal.ruleKey,
          href: `${acct}/signals`,
        }
      : null,
    actions,
    checkpoints: cps.map((c) => ({
      day: c.day,
      status: c.status,
      actionTaken: c.actionTaken ?? null,
      dueOn: c.dueOn ?? null,
      detail: c.detail ?? null,
      evidence: c.evidence.map((e) => evidenceItem(e.sourceType, e.sourceId)),
    })),
    moneyVisible: visible,
    arrAtFlagMinor: visible ? r.arrAtFlagMinor : null,
    arrCurrency: r.arrCurrency,
    saved,
    valueSavedMinor: visible && saved ? r.arrAtFlagMinor : null,
  };
}

/** Records on one account (Account 360 › Outcomes tab), newest flag first. */
export async function listAccountOutcomes(actor: Actor, accountId: string) {
  const grant = requirePermission(actor, "reports:view");
  const rows = await scopedDb(actor).outcomeRecord.findMany({
    where: { AND: [{ accountId }, { account: bookWhere(actor, grant.scope) }] },
    select: {
      id: true,
      flagType: true,
      flaggedAt: true,
      actionTaken: true,
      d7Outcome: true,
      d30Outcome: true,
      d90Outcome: true,
      signal: { select: { title: true } },
    },
    orderBy: [{ flaggedAt: "desc" }, { id: "asc" }],
  });
  const status = (j: unknown) => {
    const p = looseCheckpoint.safeParse(j);
    return p.success ? p.data.status : null;
  };
  return rows.map((r) => ({
    id: r.id,
    flagType: r.flagType,
    flaggedAt: r.flaggedAt,
    actionTaken: r.actionTaken,
    title: r.signal?.title ?? null,
    d7: status(r.d7Outcome),
    d30: status(r.d30Outcome),
    d90: status(r.d90Outcome),
  }));
}
