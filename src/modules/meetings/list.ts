import { requirePermission } from "@/lib/auth/permissions";
import { businessClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "../accounts/service";

/** Rows per section; the index is a recent-first overview, not an archive browser. */
export const MEETINGS_INDEX_LIMIT = 50;

export interface MeetingIndexRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  accountId: string | null;
  /** Null for a call no account could be matched to (shown only to members with the whole book). */
  accountName: string | null;
  hasBrief: boolean;
  hasSummary: boolean;
}

export interface QbrIndexRow {
  id: string;
  title: string;
  period: string | null;
  accountId: string;
  accountName: string;
  locked: boolean;
  createdAt: Date;
}

export interface MeetingsIndex {
  /** Not yet started, soonest first. */
  upcoming: MeetingIndexRow[];
  /** Already started, most recent first. */
  past: MeetingIndexRow[];
  qbrs: QbrIndexRow[];
}

/**
 * The Meetings & QBRs screen (spec §5): meetings and the QBRs already drafted, limited to the
 * member's book (same scope as Accounts). Meetings with no matched account are visible only to a
 * member whose scope is the whole workspace. Optionally narrowed to one account for Account 360.
 */
export async function listMeetingsIndex(
  actor: Actor,
  opts: { accountId?: string; now?: Date } = {},
): Promise<MeetingsIndex> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const now = opts.now ?? businessClock();
  const account = bookWhere(actor, grant.scope);
  const meetingWhere = {
    status: { not: "CANCELLED" as const },
    ...(opts.accountId
      ? { accountId: opts.accountId, account }
      : grant.scope === "ALL"
        ? {}
        : { account }),
  };
  const row = (m: {
    id: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    accountId: string | null;
    briefDocumentId: string | null;
    summaryAgentRunId: string | null;
    account: { name: string } | null;
  }): MeetingIndexRow => ({
    id: m.id,
    title: m.title,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    status: m.status,
    accountId: m.accountId,
    accountName: m.account?.name ?? null,
    hasBrief: m.briefDocumentId !== null,
    hasSummary: m.summaryAgentRunId !== null,
  });
  const include = { account: { select: { name: true } } };
  const [upcoming, past, qbrs] = await Promise.all([
    db.meeting.findMany({
      where: { ...meetingWhere, startsAt: { gte: now } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: MEETINGS_INDEX_LIMIT,
      include,
    }),
    db.meeting.findMany({
      where: { ...meetingWhere, startsAt: { lt: now } },
      orderBy: [{ startsAt: "desc" }, { id: "desc" }],
      take: MEETINGS_INDEX_LIMIT,
      include,
    }),
    db.document.findMany({
      where: {
        kind: "QBR",
        account: { ...account, ...(opts.accountId ? { id: opts.accountId } : {}) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MEETINGS_INDEX_LIMIT,
      include: { account: { select: { name: true } } },
    }),
  ]);
  return {
    upcoming: upcoming.map(row),
    past: past.map(row),
    qbrs: qbrs.map((d) => {
      const metrics = (d.metrics ?? {}) as Record<string, unknown>;
      return {
        id: d.id,
        title: d.title,
        period: typeof metrics.period === "string" ? metrics.period : null,
        accountId: d.accountId,
        accountName: d.account.name,
        locked: d.lockedAt !== null,
        createdAt: d.createdAt,
      };
    }),
  };
}
