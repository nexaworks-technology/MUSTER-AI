import {
  addDays,
  calendarDateOf,
  localDate,
  startOfLocalDay,
  utcMidnight,
  type CalendarDate,
} from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import { deriveTier, tierRuleFor } from "@/modules/accounts/service";
import { currentUsageSql, ownBaselinesSql } from "./baselines-sql";
import { cohortBaseline, type Peer } from "./engine/baselines";
import { DEFAULT_PARAMS } from "./engine/model";
import type { AccountBundle, Tier } from "./engine/types";

/**
 * Point-in-time loader (ARCHITECTURE §4.5, M3 rule 4, D-56). Builds AccountBundles for a chunk
 * of accounts AS OF a calendar date, with a fixed number of set-based queries (§11, no N+1).
 *
 * Every read is cut at the as-of date: calendar fields (D-50) by their day, moments by the
 * workspace-local day they fall on. Facts that carry no date of their own are dated as follows:
 * contact status by statusChangedAt (else the row's createdAt), escalation by escalatedAt (else
 * createdAt), ticket priority by priorityChangedAt (else the opening priority; D-64), tier by the
 * ARR from revenue events up to the date. lifecycleStage, churnedAt and
 * Invoice.failureCount are never read here.
 */
export interface LoadContext {
  workspaceId: string;
  timeZone: string;
  baseCurrency: string;
}

const BOUNCE = /^(mailer-daemon|postmaster)@/i;
const USAGE_DAYS = 120; // own normal reaches back 104 days; seat trend 91.
const MESSAGE_DAYS = 200; // champion rhythm 180 days; reply rate 103.

export async function loadBundles(
  db: ScopedDb,
  ctx: LoadContext,
  asOf: CalendarDate,
  accountIds: string[],
): Promise<Map<string, AccountBundle>> {
  const { workspaceId, timeZone } = ctx;
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return new Map();
  const dayEnd = startOfLocalDay(addDays(asOf, 1), timeZone); // moments strictly before this
  const asOfDay = utcMidnight(asOf); // calendar fields on or before this
  const local = (d: Date) => localDate(d, timeZone);
  /** A dated fact from after the as-of date was not known yet: it is cut, not passed on. */
  const known = (d: CalendarDate | null) => (d !== null && d <= asOf ? d : null);
  const inIds = { accountId: { in: ids } };

  const [
    accounts,
    peers,
    baselines,
    usage,
    userUsage,
    featureUsage,
    catalog,
    contracts,
    messages,
    messagedEver,
    anyTicket,
    tickets,
    contacts,
    roles,
    invoices,
    revenueEvents,
    pulses,
    surveys,
  ] = await Promise.all([
    db.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, plan: true, employeeBand: true, useCase: true },
    }),
    loadPeers(db, ctx, asOf),
    ownBaselinesSql(db, workspaceId, asOf, ids),
    db.usageDaily.findMany({
      where: { ...inIds, date: { gte: utcMidnight(addDays(asOf, -USAGE_DAYS)), lte: asOfDay } },
      select: { id: true, accountId: true, date: true, activeUsers: true, seatsUsed: true },
      orderBy: { date: "asc" },
    }),
    db.userUsageDaily.findMany({
      where: { ...inIds, date: { gte: utcMidnight(addDays(asOf, -90)), lte: asOfDay } },
      select: {
        accountId: true,
        externalUserId: true,
        contactId: true,
        date: true,
        events: true,
        contact: { select: { name: true } },
      },
    }),
    db.featureUsageDaily.findMany({
      where: { ...inIds, date: { gte: utcMidnight(addDays(asOf, -90)), lte: asOfDay } },
      select: { accountId: true, featureKey: true, date: true, users: true },
    }),
    db.featureCatalog.findMany({
      where: { isKeyFeature: true },
      select: { featureKey: true, label: true, includedInPlans: true },
      orderBy: { featureKey: "asc" },
    }),
    db.contract.findMany({
      where: { ...inIds, startDate: { lte: asOfDay } },
      select: {
        id: true,
        accountId: true,
        startDate: true,
        endDate: true,
        renewalDate: true,
        seatsPurchased: true,
      },
    }),
    db.message.findMany({
      where: {
        ...inIds,
        sentAt: { gte: startOfLocalDay(addDays(asOf, -MESSAGE_DAYS), timeZone), lt: dayEnd },
      },
      select: {
        id: true,
        accountId: true,
        conversationId: true,
        direction: true,
        sentAt: true,
        fromContactId: true,
        fromAddress: true,
        sentimentLabel: true,
        conversation: { select: { channel: true } },
      },
    }),
    db.message.groupBy({ by: ["accountId"], where: { ...inIds, sentAt: { lt: dayEnd } } }),
    db.ticket.findFirst({ where: { openedAt: { lt: dayEnd } }, select: { id: true } }),
    db.ticket.findMany({
      where: { ...inIds, openedAt: { lt: dayEnd } },
      select: {
        id: true,
        accountId: true,
        subject: true,
        priority: true,
        openingPriority: true,
        priorityChangedAt: true,
        openedAt: true,
        closedAt: true,
        isEscalated: true,
        escalatedAt: true,
        createdAt: true,
      },
    }),
    db.contact.findMany({
      where: inIds,
      select: {
        id: true,
        accountId: true,
        name: true,
        status: true,
        statusChangedAt: true,
        createdAt: true,
      },
    }),
    db.stakeholderRole.findMany({
      where: { ...inIds, validFrom: { lt: dayEnd } },
      select: {
        id: true,
        accountId: true,
        contactId: true,
        role: true,
        validFrom: true,
        validTo: true,
      },
    }),
    db.invoice.findMany({
      where: { ...inIds, issuedAt: { lte: asOfDay } },
      select: {
        id: true,
        accountId: true,
        number: true,
        issuedAt: true,
        dueAt: true,
        paidAt: true,
        lastFailedAt: true,
        status: true,
      },
    }),
    db.revenueEvent.findMany({
      where: { ...inIds, effectiveDate: { lte: asOfDay } },
      select: { id: true, accountId: true, type: true, deltaArrMinor: true, effectiveDate: true },
    }),
    db.csmPulse.findMany({
      where: { ...inIds, createdAt: { lt: dayEnd } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        accountId: true,
        value: true,
        comment: true,
        createdAt: true,
        expiresAt: true,
        membership: { select: { user: { select: { name: true, email: true } } } },
      },
    }),
    db.surveyResponse.findMany({
      where: { ...inIds, respondedAt: { lt: dayEnd } },
      select: {
        id: true,
        accountId: true,
        contactId: true,
        surveyId: true,
        score: true,
        respondedAt: true,
        survey: { select: { type: true } },
      },
    }),
  ]);

  const group = <T extends { accountId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.accountId, [...(m.get(r.accountId) ?? []), r]);
    return m;
  };
  const byUsage = group(usage);
  const byUser = group(userUsage);
  const byFeature = group(featureUsage);
  const byContract = group(contracts);
  const byMessage = group(messages);
  const byTicket = group(tickets);
  const byContact = group(contacts);
  const byRole = group(roles);
  const byInvoice = group(invoices);
  const byEvent = group(revenueEvents);
  const bySurvey = group(surveys);
  const messaged = new Set(messagedEver.map((m) => m.accountId));
  const peerById = new Map(peers.list.map((p) => [p.id, p]));

  const out = new Map<string, AccountBundle>();
  for (const a of accounts) {
    const me = peerById.get(a.id);
    const tier = peers.tierOf.get(a.id)!;
    const contract = (byContract.get(a.id) ?? [])
      .filter((c) => c.endDate === null || calendarDateOf(c.endDate) > asOf)
      .sort((x, y) => y.startDate.getTime() - x.startDate.getTime() || (x.id < y.id ? -1 : 1))[0];
    const usageRows = byUsage.get(a.id) ?? [];
    const pulse = pulses.find((p) => p.accountId === a.id);
    out.set(a.id, {
      accountId: a.id,
      asOf,
      tier,
      plan: a.plan,
      employeeBand: a.employeeBand,
      useCase: a.useCase,
      usage: usageRows.length
        ? usageRows.map((u) => ({
            id: u.id,
            date: calendarDateOf(u.date),
            activeUsers: u.activeUsers,
            seatsUsed: u.seatsUsed,
          }))
        : null,
      ownBaseline: baselines.get(a.id) ?? null,
      cohort: me
        ? cohortBaseline(me, peers.list, DEFAULT_PARAMS.cohortMinPeers)
        : cohortBaseline(
            {
              id: a.id,
              tier,
              plan: a.plan,
              employeeBand: a.employeeBand,
              useCase: a.useCase,
              rate: null,
            },
            peers.list,
            DEFAULT_PARAMS.cohortMinPeers,
          ),
      userUsage: byUser.has(a.id)
        ? byUser.get(a.id)!.map((u) => ({
            externalUserId: u.externalUserId,
            contactId: u.contactId,
            name: u.contact?.name ?? null,
            date: calendarDateOf(u.date),
            events: u.events,
          }))
        : null,
      featureUsage: byFeature.has(a.id)
        ? byFeature.get(a.id)!.map((f) => ({
            featureKey: f.featureKey,
            date: calendarDateOf(f.date),
            users: f.users,
          }))
        : null,
      keyFeatures: a.plan
        ? catalog
            .filter((f) => f.includedInPlans.includes(a.plan!))
            .map((f) => ({ featureKey: f.featureKey, label: f.label }))
        : [],
      contract: contract
        ? {
            id: contract.id,
            seatsPurchased: contract.seatsPurchased,
            startDate: calendarDateOf(contract.startDate),
            renewalDate: contract.renewalDate ? calendarDateOf(contract.renewalDate) : null,
          }
        : null,
      messages: messaged.has(a.id)
        ? (byMessage.get(a.id) ?? []).map((m) => ({
            id: m.id,
            conversationId: m.conversationId,
            channel: m.conversation.channel,
            direction: m.direction,
            date: local(m.sentAt),
            fromContactId: m.fromContactId,
            isBounce: !m.fromContactId && BOUNCE.test(m.fromAddress ?? ""),
            // Only when present, so unlabelled messages hash exactly as before (inputsHash), and
            // only for ticket messages: the Sentiment pillar reads no other channel (M9 D4), so a
            // label on an email must never change an input hash or look like a scoring input.
            ...(m.sentimentLabel && m.conversation.channel === "TICKET"
              ? { sentimentLabel: m.sentimentLabel }
              : {}),
          }))
        : null,
      workspaceHasTickets: anyTicket !== null,
      tickets: (byTicket.get(a.id) ?? []).map((t) => ({
        id: t.id,
        subject: t.subject,
        // D-64: a priority changed after the as-of date was not known then.
        priority:
          t.priorityChangedAt && local(t.priorityChangedAt) > asOf
            ? (t.openingPriority ?? t.priority)
            : t.priority,
        openedDate: local(t.openedAt),
        closedDate: known(t.closedAt ? local(t.closedAt) : null),
        escalatedDate: known(
          t.escalatedAt ? local(t.escalatedAt) : t.isEscalated ? local(t.createdAt) : null,
        ),
      })),
      contacts: (byContact.get(a.id) ?? []).map((c) => {
        const since = c.statusChangedAt
          ? local(c.statusChangedAt)
          : c.status === "ACTIVE"
            ? null
            : local(c.createdAt);
        // A status that became true after the date was not known: the contact was active then.
        return since !== null && since > asOf
          ? { id: c.id, name: c.name, status: "ACTIVE" as const, statusDate: null }
          : { id: c.id, name: c.name, status: c.status, statusDate: since };
      }),
      roles: (byRole.get(a.id) ?? []).map((r) => ({
        id: r.id,
        contactId: r.contactId,
        role: r.role,
        validFrom: local(r.validFrom),
        validTo: known(r.validTo ? local(r.validTo) : null),
      })),
      invoices: (byInvoice.get(a.id) ?? []).map((i) => ({
        id: i.id,
        number: i.number,
        issuedDate: calendarDateOf(i.issuedAt),
        dueDate: calendarDateOf(i.dueAt),
        paidDate: known(i.paidAt ? local(i.paidAt) : null),
        failedDate: known(i.lastFailedAt ? local(i.lastFailedAt) : null),
        isVoid: i.status === "VOID",
      })),
      revenueEvents: (byEvent.get(a.id) ?? []).map((e) => ({
        id: e.id,
        type: e.type,
        deltaArrMinor: Number(e.deltaArrMinor),
        effectiveDate: calendarDateOf(e.effectiveDate),
      })),
      pulse: pulse
        ? {
            id: pulse.id,
            value: pulse.value,
            authorName: pulse.membership.user.name ?? pulse.membership.user.email,
            comment: pulse.comment,
            createdDate: local(pulse.createdAt),
            expiresDate: local(pulse.expiresAt),
          }
        : null,
      surveys: (bySurvey.get(a.id) ?? []).map((s) => ({
        id: s.id,
        surveyId: s.surveyId,
        type: s.survey.type,
        score: s.score,
        contactId: s.contactId,
        date: local(s.respondedAt),
      })),
    });
  }
  return out;
}

/**
 * Every account's cohort attributes and active rate as of the date: tier rebuilt from ARR then
 * (manual tiers stay), rate = typical weekday active users ÷ seats on the contract active then.
 */
export async function loadPeers(
  db: ScopedDb,
  ctx: LoadContext,
  asOf: CalendarDate,
): Promise<{ list: Peer[]; tierOf: Map<string, Tier> }> {
  const asOfDay = utcMidnight(asOf);
  const [accounts, arr, current, contracts, rule] = await Promise.all([
    db.account.findMany({
      select: {
        id: true,
        tier: true,
        tierSource: true,
        plan: true,
        employeeBand: true,
        useCase: true,
      },
    }),
    db.revenueEvent.groupBy({
      by: ["accountId", "currency"],
      where: { effectiveDate: { lte: asOfDay } },
      _sum: { deltaArrMinor: true },
    }),
    currentUsageSql(db, ctx.workspaceId, asOf, DEFAULT_PARAMS.usageStaleDays),
    db.contract.findMany({
      where: { startDate: { lte: asOfDay }, OR: [{ endDate: null }, { endDate: { gt: asOfDay } }] },
      select: { id: true, accountId: true, startDate: true, seatsPurchased: true },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
    }),
    tierRuleFor(ctx.workspaceId),
  ]);
  const arrOf = new Map<string, { minor: bigint; currency: string } | null>();
  for (const r of arr) {
    // ARR in more than one currency cannot be compared with the bands: the tier does not move.
    arrOf.set(
      r.accountId,
      arrOf.has(r.accountId) ? null : { minor: r._sum.deltaArrMinor ?? 0n, currency: r.currency },
    );
  }
  const seatsOf = new Map<string, number | null>();
  for (const c of contracts)
    if (!seatsOf.has(c.accountId)) seatsOf.set(c.accountId, c.seatsPurchased);
  const tierOf = new Map<string, Tier>();
  const list = accounts.map((a): Peer => {
    const tier = deriveTier(arrOf.get(a.id) ?? null, rule, a);
    tierOf.set(a.id, tier);
    const usage = current.get(a.id);
    const seats = seatsOf.get(a.id);
    return {
      id: a.id,
      tier,
      plan: a.plan,
      employeeBand: a.employeeBand,
      useCase: a.useCase,
      rate: usage && seats ? usage.value / seats : null,
    };
  });
  return { list, tierOf };
}
