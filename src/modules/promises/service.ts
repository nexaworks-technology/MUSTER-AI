import { createHash } from "node:crypto";
import type { PromiseStatus } from "@prisma/client";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Dedupe on source + quote (whitespace and case ignored): re-reading a record never doubles it. */
export function promiseDedupeKey(sourceType: string, sourceId: string, quote: string): string {
  return createHash("sha256")
    .update(`${sourceType}\n${sourceId}\n${norm(quote)}`)
    .digest("hex");
}

export interface SortablePromise {
  status: PromiseStatus;
  ownerMembershipId: string | null;
  dueDate: string | null;
}

const rank = (p: SortablePromise): number =>
  p.status === "KEPT"
    ? 3
    : p.status === "LATE" || p.status === "BROKEN"
      ? 0
      : p.ownerMembershipId === null
        ? 1
        : 2;

const dueKey = (p: SortablePromise) => p.dueDate ?? "9999-12-31";

/** The tracker's order: late first, then no owner, then due date ascending; kept sinks. */
export function sortPromises<T extends SortablePromise>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => rank(a) - rank(b) || dueKey(a).localeCompare(dueKey(b)));
}

// ─── Database layer ───────────────────────────────────────────────────────────────────────

import type { Extraction } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { calendarDateOf, type CalendarDate } from "@/lib/dates";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import { currentExtractions, promiseParty } from "@/modules/conversations/service";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import {
  brokenAfterDaysSchema,
  DEFAULT_BROKEN_AFTER_DAYS,
  promiseStatus,
  type PromiseEvidence,
} from "./status";

const dayOf = (d: Date | null): CalendarDate | null => (d ? calendarDateOf(d) : null);
const utc = (d: CalendarDate) => new Date(`${d}T00:00:00Z`);

export class PromiseEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromiseEvidenceError";
  }
}

export interface SyncResult {
  promisesCreated: number;
  goalsCreated: number;
  statusChanged: number;
}

async function brokenAfterDays(db: ScopedDb): Promise<number> {
  const row = await db.signalRule.findFirst({
    where: { ruleKey: "promise_late" },
    select: { params: true },
  });
  const raw = (row?.params as { brokenAfterDays?: unknown } | null)?.brokenAfterDays;
  return brokenAfterDaysSchema.catch(DEFAULT_BROKEN_AFTER_DAYS).parse(raw);
}

/** The people each source's speakers can be matched against, in set-based reads. */
async function partyInputs(db: ScopedDb, rows: Extraction[]) {
  const ids = (type: string) => [
    ...new Set(rows.filter((r) => r.sourceType === type).map((r) => r.sourceId)),
  ];
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const [messages, transcripts, members, contacts] = await Promise.all([
    db.message.findMany({
      where: { id: { in: ids("MESSAGE") } },
      select: { id: true, direction: true, bodyText: true },
    }),
    db.callTranscript.findMany({
      where: { id: { in: ids("CALL_TRANSCRIPT") } },
      select: { id: true, text: true },
    }),
    db.membership.findMany({
      where: { status: "ACTIVE" },
      select: { user: { select: { name: true } } },
    }),
    db.contact.findMany({
      where: { accountId: { in: accountIds } },
      select: { accountId: true, name: true },
    }),
  ]);
  return {
    message: new Map(messages.map((m) => [m.id, m])),
    transcript: new Map(transcripts.map((t) => [t.id, t.text])),
    members: members.flatMap((m) => (m.user.name ? [m.user.name] : [])),
    contactsOf: (accountId: string) =>
      contacts.filter((c) => c.accountId === accountId).map((c) => c.name),
  };
}

async function createPromises(
  db: ScopedDb,
  workspaceId: string,
  rows: Extraction[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const keyed = rows.map((r) => ({ r, key: promiseDedupeKey(r.sourceType, r.sourceId, r.quote) }));
  const have = await db.promise.findMany({
    where: { dedupeKey: { in: keyed.map((k) => k.key) } },
    select: { accountId: true, dedupeKey: true },
  });
  const seen = new Set(have.map((h) => `${h.accountId}:${h.dedupeKey}`));
  const fresh = keyed.filter((k) => {
    const id = `${k.r.accountId}:${k.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (fresh.length === 0) return 0;
  const inputs = await partyInputs(
    db,
    fresh.map((f) => f.r),
  );
  let created = 0;
  for (const { r, key } of fresh) {
    const payload = r.payload as {
      what?: string;
      dueDate?: string | null;
      party?: "us" | "customer" | null;
    };
    const msg = r.sourceType === "MESSAGE" ? inputs.message.get(r.sourceId) : undefined;
    const text =
      r.sourceType === "CALL_TRANSCRIPT"
        ? (inputs.transcript.get(r.sourceId) ?? "")
        : (msg?.bodyText ?? r.quote);
    const who = promiseParty({
      sourceType: r.sourceType,
      ...(msg ? { direction: msg.direction } : {}),
      quote: r.quote,
      sourceText: text,
      members: inputs.members,
      contacts: inputs.contactsOf(r.accountId),
      modelGuess: payload.party ?? null,
    });
    const due =
      payload.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.dueDate) ? payload.dueDate : null;
    await db.promise.create({
      data: {
        workspaceId,
        accountId: r.accountId,
        party: who.party,
        suggestedParty: who.suggestedParty,
        what: payload.what ?? r.quote,
        dueDate: due ? utc(due) : null,
        status: "OPEN",
        statusReason: "Not computed yet.",
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        quote: r.quote,
        extractionId: r.id,
        dedupeKey: key,
        origin: "AI",
        agentRunId: r.agentRunId,
      },
    });
    created++;
  }
  return created;
}

async function createGoals(db: ScopedDb, workspaceId: string, rows: Extraction[]): Promise<number> {
  if (rows.length === 0) return 0;
  const have = await db.goal.findMany({
    where: { extractionId: { in: rows.map((r) => r.id) } },
    select: { extractionId: true },
  });
  const seen = new Set(have.map((g) => g.extractionId));
  let created = 0;
  for (const r of rows.filter((x) => !seen.has(x.id))) {
    const goal = (r.payload as { goal?: string }).goal ?? r.quote;
    await db.goal.create({
      data: {
        workspaceId,
        accountId: r.accountId,
        text: goal,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        quote: r.quote,
        extractionId: r.id,
        origin: "AI",
        agentRunId: r.agentRunId,
      },
    });
    created++;
  }
  return created;
}

/** Evidence from records, never from a model: our promise made in a ticket thread, then that ticket closed. */
async function ticketEvidence(
  db: ScopedDb,
  promises: Array<{
    id: string;
    party: string;
    sourceType: string | null;
    sourceId: string | null;
  }>,
): Promise<Map<string, PromiseEvidence>> {
  const ours = promises.filter((p) => p.party === "US" && p.sourceType === "MESSAGE" && p.sourceId);
  const out = new Map<string, PromiseEvidence>();
  if (ours.length === 0) return out;
  const messages = await db.message.findMany({
    where: { id: { in: ours.map((p) => p.sourceId!) } },
    select: { id: true, conversationId: true, sentAt: true },
  });
  const tickets = await db.ticket.findMany({
    where: {
      conversationId: { in: [...new Set(messages.map((m) => m.conversationId))] },
      closedAt: { not: null },
    },
    select: { id: true, conversationId: true, closedAt: true },
    orderBy: { closedAt: "asc" },
  });
  const msgById = new Map(messages.map((m) => [m.id, m]));
  for (const p of ours) {
    const m = msgById.get(p.sourceId!);
    const t =
      m && tickets.find((x) => x.conversationId === m.conversationId && x.closedAt! >= m.sentAt);
    if (t) out.set(p.id, { type: "Ticket", id: t.id, date: calendarDateOf(t.closedAt!) });
  }
  return out;
}

async function refreshStatuses(
  db: ScopedDb,
  today: CalendarDate,
  accountIds: string[] | undefined,
): Promise<number> {
  const [promises, broken] = await Promise.all([
    db.promise.findMany({ where: accountIds ? { accountId: { in: accountIds } } : {} }),
    brokenAfterDays(db),
  ]);
  const auto = await ticketEvidence(
    db,
    promises.filter((p) => !p.evidenceId),
  );
  let changed = 0;
  for (const p of promises) {
    const stored: PromiseEvidence | null =
      p.evidenceType && p.evidenceId && p.keptAt
        ? { type: p.evidenceType, id: p.evidenceId, date: calendarDateOf(p.keptAt) }
        : null;
    const evidence = stored ?? auto.get(p.id) ?? null;
    const r = promiseStatus({
      dueDate: dayOf(p.dueDate),
      today,
      evidence,
      brokenAfterDays: broken,
    });
    const needsEvidence = !stored && evidence !== null;
    if (r.status === p.status && r.reason === p.statusReason && !needsEvidence) continue;
    await db.promise.update({
      where: { id: p.id },
      data: {
        status: r.status,
        statusReason: r.reason,
        statusComputedAt: new Date(),
        ...(needsEvidence
          ? { evidenceType: evidence.type, evidenceId: evidence.id, keptAt: utc(evidence.date) }
          : {}),
      },
    });
    changed++;
  }
  return changed;
}

/**
 * The Promise engine for one workspace (or a chunk of its accounts): PROMISE extractions become
 * Promise rows, GOAL extractions become AI-origin Goals (both only from the latest prompt version
 * per source), then every promise's status is recomputed by code for `today`. Idempotent.
 */
export async function syncPromises(
  ctx: TenantContext,
  opts: { today: CalendarDate; accountIds?: string[] },
): Promise<SyncResult> {
  const db = scopedDb(ctx);
  const rows = await currentExtractions(db, {
    kinds: ["PROMISE", "GOAL"],
    ...(opts.accountIds ? { accountIds: opts.accountIds } : {}),
  });
  const promisesCreated = await createPromises(
    db,
    ctx.workspaceId,
    rows.filter((r) => r.kind === "PROMISE"),
  );
  const goalsCreated = await createGoals(
    db,
    ctx.workspaceId,
    rows.filter((r) => r.kind === "GOAL"),
  );
  const statusChanged = await refreshStatuses(db, opts.today, opts.accountIds);
  return { promisesCreated, goalsCreated, statusChanged };
}

export type EvidenceType = "Ticket" | "Message" | "Note" | "Task";

/** A person records that a promise was kept, pointing at a record on the same account (audited). */
export async function markPromiseKept(
  actor: Actor,
  input: { promiseId: string; evidence: { type: EvidenceType; id: string }; today: CalendarDate },
): Promise<void> {
  const db = scopedDb(actor);
  const p = await db.promise.findUnique({ where: { id: input.promiseId } });
  if (!p) throw new PromiseEvidenceError("That promise was not found.");
  const where = { id: input.evidence.id, accountId: p.accountId };
  const found =
    input.evidence.type === "Ticket"
      ? await db.ticket.findFirst({ where, select: { id: true } })
      : input.evidence.type === "Message"
        ? await db.message.findFirst({ where, select: { id: true } })
        : input.evidence.type === "Note"
          ? await db.note.findFirst({ where, select: { id: true } })
          : await db.task.findFirst({ where, select: { id: true } });
  if (!found)
    throw new PromiseEvidenceError(
      `That ${input.evidence.type.toLowerCase()} is not on this account, so it cannot show the promise was kept.`,
    );
  const r = promiseStatus({
    dueDate: dayOf(p.dueDate),
    today: input.today,
    evidence: { type: input.evidence.type, id: input.evidence.id, date: input.today },
    brokenAfterDays: await brokenAfterDays(db),
  });
  await db.promise.update({
    where: { id: p.id },
    data: {
      status: r.status,
      statusReason: r.reason,
      statusComputedAt: new Date(),
      evidenceType: input.evidence.type,
      evidenceId: input.evidence.id,
      keptAt: utc(input.today),
    },
  });
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "promise.kept",
    targetType: "Promise",
    targetId: p.id,
    summary: `Marked a promise kept, with ${input.evidence.type.toLowerCase()} ${input.evidence.id} as evidence`,
    before: { status: p.status },
    after: { status: r.status, evidence: input.evidence },
  });
}

// ─── Tracker reads and the three things a person can do (M9 B3) ───────────────────────────────

export class PromiseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromiseInputError";
  }
}

export interface PromiseRow {
  id: string;
  account: { id: string; name: string };
  what: string;
  party: "US" | "CUSTOMER" | "UNCLEAR";
  suggestedParty: "US" | "CUSTOMER" | null;
  status: "OPEN" | "KEPT" | "LATE" | "BROKEN";
  statusReason: string;
  dueDate: string | null;
  owner: { id: string; name: string } | null;
  quote: string | null;
  source: { type: string; id: string } | null;
  origin: "HUMAN" | "SYSTEM" | "AI" | "IMPORT";
}

export const PROMISE_PAGE = 50;

/** The tracker: late first, then no owner, then due date; kept ones only under "All". Book-scoped. */
export async function listPromises(
  actor: Actor,
  q: { status?: "OPEN" | "ALL"; accountId?: string; cursor?: string },
): Promise<{ rows: PromiseRow[]; nextCursor: string | null }> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const found = await db.promise.findMany({
    where: {
      account: bookWhere(actor, grant.scope),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.status === "ALL" ? {} : { status: { not: "KEPT" } }),
    },
    include: {
      account: { select: { id: true, name: true } },
      owner: { select: { id: true, user: { select: { name: true, email: true } } } },
    },
    take: 500,
  });
  const rows: PromiseRow[] = sortPromises(
    found.map((p) => ({
      id: p.id,
      account: p.account,
      what: p.what,
      party: p.party,
      suggestedParty: p.suggestedParty === "UNCLEAR" ? null : p.suggestedParty,
      status: p.status,
      statusReason: p.statusReason,
      dueDate: p.dueDate ? calendarDateOf(p.dueDate) : null,
      ownerMembershipId: p.ownerMembershipId,
      owner: p.owner ? { id: p.owner.id, name: p.owner.user.name ?? p.owner.user.email } : null,
      quote: p.quote,
      source: p.sourceType && p.sourceId ? { type: p.sourceType, id: p.sourceId } : null,
      origin: p.origin,
    })),
  ).map(({ ownerMembershipId: _unused, ...r }) => r);
  const offset = /^\d{1,5}$/.test(q.cursor ?? "") ? Number(q.cursor) : 0;
  const page = rows.slice(offset, offset + PROMISE_PAGE);
  return {
    rows: page,
    nextCursor: offset + PROMISE_PAGE < rows.length ? String(offset + PROMISE_PAGE) : null,
  };
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d,
    "That is not a real date.",
  );

const createInput = z.object({
  accountId: z.string().min(1),
  what: z.string().trim().min(1, "Say what was promised.").max(300),
  party: z.enum(["US", "CUSTOMER"]),
  dueDate: day.optional(),
  ownerMembershipId: z.string().min(1).nullish(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function invalid(e: unknown): never {
  if (e instanceof z.ZodError)
    throw new PromiseInputError(e.issues[0]?.message ?? "Check the form.");
  throw e;
}

async function activeOwner(db: ScopedDb, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const m = await db.membership.findFirst({
    where: { id, status: "ACTIVE" },
    select: { id: true },
  });
  if (!m) throw new PromiseInputError("That person is not an active member of this workspace.");
  return m.id;
}

/** A promise entered by hand: no quote is invented, the status is computed like any other. */
export async function createPromise(
  actor: Actor,
  raw: z.input<typeof createInput>,
): Promise<{ id: string }> {
  const grant = requirePermission(actor, "accounts:edit");
  let input: z.infer<typeof createInput>;
  try {
    input = createInput.parse(raw);
  } catch (e) {
    invalid(e);
  }
  const db = scopedDb(actor);
  const account = await db.account.findFirst({
    where: { AND: [{ id: input.accountId }, bookWhere(actor, grant.scope)] },
    select: { id: true },
  });
  if (!account) throw new PromiseInputError("That account was not found in your book.");
  const owner = await activeOwner(db, input.ownerMembershipId);
  const r = promiseStatus({
    dueDate: input.dueDate ?? null,
    today: input.today,
    evidence: null,
    brokenAfterDays: await brokenAfterDays(db),
  });
  const created = await db.promise.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: account.id,
      party: input.party,
      what: input.what,
      dueDate: input.dueDate ? utc(input.dueDate) : null,
      ownerMembershipId: owner,
      status: r.status,
      statusReason: r.reason,
      dedupeKey: `manual:${randomUUID()}`,
      origin: "HUMAN",
      createdByMembershipId: actor.membershipId,
    },
  });
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "promise.created",
    targetType: "Promise",
    targetId: created.id,
    summary: `Added a promise by hand: ${input.what}`,
    after: { party: input.party, dueDate: input.dueDate ?? null, status: r.status },
  });
  return { id: created.id };
}

export async function setPromiseOwner(
  actor: Actor,
  input: { promiseId: string; ownerMembershipId: string | null },
): Promise<void> {
  const grant = requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const p = await db.promise.findFirst({
    where: { AND: [{ id: input.promiseId }, { account: bookWhere(actor, grant.scope) }] },
    select: { id: true, ownerMembershipId: true, what: true },
  });
  if (!p) throw new PromiseInputError("That promise was not found.");
  const owner = await activeOwner(db, input.ownerMembershipId);
  await db.promise.update({ where: { id: p.id }, data: { ownerMembershipId: owner } });
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "promise.owner_set",
    targetType: "Promise",
    targetId: p.id,
    summary: owner
      ? `Gave a promise an owner: ${p.what}`
      : `Cleared the owner of a promise: ${p.what}`,
    before: { ownerMembershipId: p.ownerMembershipId },
    after: { ownerMembershipId: owner },
  });
}

/** "How it was kept" is written as a note on the account, and that note is the evidence. */
export async function markPromiseKeptWithNote(
  actor: Actor,
  input: { promiseId: string; text: string; today: CalendarDate },
): Promise<void> {
  const grant = requirePermission(actor, "accounts:edit");
  const text = input.text.trim();
  if (!text) throw new PromiseInputError("Say how it was kept.");
  const db = scopedDb(actor);
  const p = await db.promise.findFirst({
    where: { AND: [{ id: input.promiseId }, { account: bookWhere(actor, grant.scope) }] },
    select: { id: true, accountId: true },
  });
  if (!p) throw new PromiseInputError("That promise was not found.");
  const note = await db.note.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: p.accountId,
      authorMembershipId: actor.membershipId,
      body: text.slice(0, 4000),
      tags: ["promise-kept"],
      mentionMembershipIds: [],
      origin: "HUMAN",
    },
  });
  await markPromiseKept(actor, {
    promiseId: p.id,
    evidence: { type: "Note", id: note.id },
    today: input.today,
  });
}

/** Active members who can own a promise, by name. */
export async function listOwnerChoices(actor: Actor): Promise<Array<{ id: string; name: string }>> {
  requirePermission(actor, "accounts:view");
  const rows = await scopedDb(actor).membership.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { id: "asc" },
    take: 100,
  });
  return rows
    .map((m) => ({ id: m.id, name: m.user.name ?? m.user.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
