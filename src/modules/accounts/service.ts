import type { BookScope, Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { can, ForbiddenError, requirePermission, type Grant } from "@/lib/auth/permissions";
import type { WorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { minorDigits } from "@/lib/money";
import { workspaceSettingsData } from "@/modules/settings/schemas";
import { getSettingsData } from "@/modules/settings/service";
import { segmentWhere } from "@/modules/segments/service";
import { deriveTier } from "./tier";

export { deriveTier, type TierRule } from "./tier";
import { nextMissingQuestion, type MissingField } from "./missing-data";
import { accountPatch, PAGE_SIZE, type AccountListQuery } from "./schemas";

/**
 * Accounts — the Account Graph's read and write paths (ARCHITECTURE §2 `accounts`).
 * Every read is book-scoped (ARCHITECTURE §7.2) and money is returned only with revenue:view.
 */
export type Actor = Pick<
  WorkspaceContext,
  "workspaceId" | "userId" | "membershipId" | "role" | "canViewRevenue" | "bookScope"
>;

/**
 * Book scope as a where clause. TEAM = own accounts + unowned accounts (the shared pool):
 * there is no team model yet (DECISIONS D-41, QUESTIONS Q-35).
 */
export function bookWhere(
  actor: Pick<Actor, "membershipId">,
  scope: BookScope,
): Prisma.AccountWhereInput {
  if (scope === "ALL") return {};
  if (scope === "OWN") return { ownerMembershipId: actor.membershipId };
  return { OR: [{ ownerMembershipId: actor.membershipId }, { ownerMembershipId: null }] };
}

export interface AccountListRow {
  id: string;
  name: string;
  domain: string | null;
  tier: "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
  lifecycleStage: "ONBOARDING" | "ADOPTING" | "MATURE" | "RENEWING" | "LOST";
  ownerName: string | null;
  /** Present only for members with revenue:view; otherwise the key is absent entirely. */
  arr?: { minor: bigint; currency: string } | null;
  lastTouchAt: Date | null;
  renewalDate: Date | null;
  ownerMembershipId: string | null;
  hasContract: boolean;
  canEdit: boolean;
}

export interface AccountListPage {
  rows: AccountListRow[];
  total: number;
  offset: number;
  nextCursor: string | null;
  prevCursor: string | null;
  arrVisible: boolean;
  /** Owner changes need workspace-wide edit rights. */
  canChangeOwner: boolean;
  segmentName: string | null;
  /** A segment id was given but it does not exist here (or no longer validates). */
  segmentMissing: boolean;
}

function orderBy(
  query: AccountListQuery,
  arrVisible: boolean,
): Prisma.AccountOrderByWithRelationInput[] {
  // Sorting by ARR would leak relative contract values, so without revenue access the list
  // falls back to the default order (name, ascending).
  const blocked = query.sort === "arr" && !arrVisible;
  const sort = blocked ? "name" : query.sort;
  const dir = blocked ? "asc" : query.dir;
  const primary: Prisma.AccountOrderByWithRelationInput =
    sort === "arr"
      ? { arrMinor: { sort: dir, nulls: "last" } }
      : sort === "lastTouch"
        ? { lastTouchAt: { sort: dir, nulls: "last" } }
        : sort === "renewal"
          ? { renewalDate: { sort: dir, nulls: "last" } }
          : { name: dir };
  return [primary, { id: "asc" }];
}

export function listWhere(
  actor: Actor,
  grant: Grant,
  query: AccountListQuery,
): Prisma.AccountWhereInput {
  const and: Prisma.AccountWhereInput[] = [bookWhere(actor, grant.scope), { archivedAt: null }];
  if (query.q) {
    and.push({
      OR: [
        { name: { contains: query.q, mode: "insensitive" } },
        { domain: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }
  if (query.tier) and.push({ tier: query.tier });
  if (query.stage) and.push({ lifecycleStage: query.stage });
  if (query.health) and.push({ currentHealth: { is: { riskLevel: query.health } } });
  if (query.owner === "none") and.push({ ownerMembershipId: null });
  else if (query.owner) and.push({ ownerMembershipId: query.owner });
  return { AND: and };
}

/**
 * One page of accounts. The cursor is an opaque offset over a fully deterministic order
 * (sort field, then id), so pages never skip or repeat rows (DECISIONS D-42).
 */
export async function listAccounts(
  actor: Actor,
  query: AccountListQuery,
): Promise<AccountListPage> {
  const grant = requirePermission(actor, "accounts:view");
  const arrVisible = can(actor, "revenue:view") !== null;
  const offset = Number(query.cursor ?? 0);
  let where = listWhere(actor, grant, query);
  let segmentName: string | null = null;
  let segmentMissing = false;
  if (query.segment) {
    const seg = await segmentWhere(actor, query.segment);
    if (seg) {
      where = { AND: [where, seg.where] };
      segmentName = seg.name;
    } else {
      segmentMissing = true;
    }
  }
  const db = scopedDb(actor);
  const [total, accounts] = await Promise.all([
    db.account.count({ where }),
    db.account.findMany({
      where,
      orderBy: orderBy(query, arrVisible),
      skip: offset,
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        name: true,
        domain: true,
        tier: true,
        lifecycleStage: true,
        lastTouchAt: true,
        renewalDate: true,
        ownerMembershipId: true,
        _count: { select: { contracts: true } },
        arrMinor: arrVisible,
        arrCurrency: arrVisible,
        owner: { select: { user: { select: { name: true, email: true } } } },
      },
    }),
  ]);
  const rows = accounts.slice(0, PAGE_SIZE).map((a): AccountListRow => {
    const row: AccountListRow = {
      id: a.id,
      name: a.name,
      domain: a.domain,
      tier: a.tier,
      lifecycleStage: a.lifecycleStage,
      ownerName: a.owner ? (a.owner.user.name ?? a.owner.user.email) : null,
      lastTouchAt: a.lastTouchAt,
      renewalDate: a.renewalDate,
      ownerMembershipId: a.ownerMembershipId,
      hasContract: a._count.contracts > 0,
      canEdit: canEditAccount(actor, a.ownerMembershipId),
    };
    if (arrVisible)
      row.arr =
        a.arrMinor !== null && a.arrMinor !== undefined
          ? { minor: a.arrMinor, currency: a.arrCurrency ?? "USD" }
          : null;
    return row;
  });
  return {
    rows,
    total,
    offset,
    nextCursor: accounts.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    prevCursor: offset > 0 ? String(Math.max(0, offset - PAGE_SIZE)) : null,
    arrVisible,
    canChangeOwner: can(actor, "accounts:edit")?.scope === "ALL",
    segmentName,
    segmentMissing,
  };
}

/** Members who can own accounts, for the owner filter and inline edit. */
export async function listOwners(actor: Actor) {
  requirePermission(actor, "accounts:view");
  const members = await scopedDb(actor).membership.findMany({
    where: { status: "ACTIVE", role: { in: ["ADMIN", "CS_LEADER", "CSM"] } },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m) => ({ membershipId: m.id, name: m.user.name ?? m.user.email }));
}

// ─── Account 360 ─────────────────────────────────────────────────────────────

/** Thrown when an account is outside the actor's workspace or book: callers render a 404. */
export class AccountNotFoundError extends Error {
  constructor() {
    super("Account not found");
    this.name = "AccountNotFoundError";
  }
}

/**
 * The account header used by every Account 360 tab. Returns null for accounts in another
 * workspace (RLS + scoping) or outside the actor's book, so the route 404s either way.
 */
export async function getAccount(actor: Actor, accountId: string) {
  const grant = requirePermission(actor, "accounts:view");
  const arrVisible = can(actor, "revenue:view") !== null;
  const account = await scopedDb(actor).account.findFirst({
    where: { AND: [{ id: accountId }, bookWhere(actor, grant.scope)] },
    select: {
      id: true,
      name: true,
      domain: true,
      tier: true,
      tierSource: true,
      lifecycleStage: true,
      onboardingStartedAt: true,
      churnedAt: true,
      ownerMembershipId: true,
      plan: true,
      industry: true,
      employeeBand: true,
      timezone: true,
      lastTouchAt: true,
      source: true,
      arrMinor: arrVisible,
      arrCurrency: arrVisible,
      owner: { select: { user: { select: { name: true, email: true } } } },
    },
  });
  if (!account) return null;
  const { arrMinor, arrCurrency, owner, ...rest } = account;
  return {
    ...rest,
    ownerName: owner ? (owner.user.name ?? owner.user.email) : null,
    arrVisible,
    arr:
      arrVisible && arrMinor !== null && arrMinor !== undefined
        ? { minor: arrMinor, currency: arrCurrency ?? "USD" }
        : null,
    canEdit: canEditAccount(actor, rest.ownerMembershipId),
  };
}

export type AccountHeader = NonNullable<Awaited<ReturnType<typeof getAccount>>>;

/** accounts:edit within the actor's book (Viewers never; CSMs only their book). */
export function canEditAccount(actor: Actor, ownerMembershipId: string | null): boolean {
  const grant = can(actor, "accounts:edit");
  if (!grant) return false;
  if (grant.scope === "ALL") return true;
  if (ownerMembershipId === actor.membershipId) return true;
  return grant.scope === "TEAM" && ownerMembershipId === null;
}

/** Loads the account for a write and enforces accounts:edit within the actor's book. */
export async function requireEditableAccount(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  if (!account.canEdit) throw new ForbiddenError("accounts:edit");
  return account;
}

/**
 * Last touch = the latest two-way interaction between our customer's team and the account:
 * email/chat/call/meeting messages and call transcripts. Support tickets are not a CSM touch.
 * Derived, never typed in; no interaction on record = null (shown as "No contact recorded").
 */
export async function recomputeLastTouch(
  db: Pick<ReturnType<typeof scopedDb>, "$executeRaw">,
  workspaceId: string,
): Promise<number> {
  return db.$executeRaw`
    UPDATE "Account" a SET "lastTouchAt" = t.last
    FROM (
      SELECT acc.id AS "accountId", max(x.at) AS last
      FROM "Account" acc
      LEFT JOIN (
        SELECT m."accountId", m."sentAt" AS at
        FROM "Message" m
        JOIN "Conversation" c ON c."workspaceId" = m."workspaceId" AND c.id = m."conversationId"
        WHERE m."workspaceId" = ${workspaceId} AND c.channel IN ('EMAIL', 'CHAT', 'CALL', 'MEETING')
        UNION ALL
        SELECT ct."accountId", ct."occurredAt" AS at FROM "CallTranscript" ct WHERE ct."workspaceId" = ${workspaceId}
      ) x ON x."accountId" = acc.id
      WHERE acc."workspaceId" = ${workspaceId}
      GROUP BY acc.id
    ) t
    WHERE a.id = t."accountId" AND a."workspaceId" = ${workspaceId}
      AND a."lastTouchAt" IS DISTINCT FROM t.last`;
}

// ─── Inline edit & tier rule ─────────────────────────────────────────────────

/** A failure the user can act on; the message is safe to show. */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountInputError";
  }
}

/** The workspace's ARR tier bands in minor units (also used by health to rebuild tier as of a date). */
export async function tierRuleFor(workspaceId: string) {
  const [settings, workspace] = await Promise.all([
    getSettingsData(workspaceId),
    getOwnWorkspace({ workspaceId }),
  ]);
  const scale = 10n ** BigInt(minorDigits(workspace.baseCurrency));
  return {
    highTouchMinArrMinor: BigInt(settings.tierRule.highTouchMinArr) * scale,
    midTouchMinArrMinor: BigInt(settings.tierRule.midTouchMinArr) * scale,
    currency: workspace.baseCurrency,
  };
}

/**
 * Re-derives one account's tier from its ARR (no-op for manual tiers or missing ARR). The bands
 * are read through `tx`: a scopedDb read nested in a tenant transaction runs on another
 * connection without the workspace setting and would see no settings row (QUESTIONS Q-54).
 */
export async function applyTierRule(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
  const arr =
    account.arrMinor !== null && account.arrCurrency
      ? { minor: account.arrMinor, currency: account.arrCurrency }
      : null;
  const row = await tx.workspaceSettings.findUnique({ where: { workspaceId } });
  const parsed = workspaceSettingsData.safeParse(row?.data ?? {});
  const settings = parsed.success ? parsed.data : workspaceSettingsData.parse({});
  const workspace = await getOwnWorkspace({ workspaceId });
  const scale = 10n ** BigInt(minorDigits(workspace.baseCurrency));
  const rule = {
    highTouchMinArrMinor: BigInt(settings.tierRule.highTouchMinArr) * scale,
    midTouchMinArrMinor: BigInt(settings.tierRule.midTouchMinArr) * scale,
    currency: workspace.baseCurrency,
  };
  const tier = deriveTier(arr, rule, account);
  if (tier !== account.tier) await tx.account.update({ where: { id: accountId }, data: { tier } });
}

/**
 * Inline edit (Accounts list): owner, tier (or back to the ARR rule) and stage. Changing the
 * owner needs workspace-wide edit rights (Admin / CS Leader); a CSM edits only their book.
 */
export async function updateAccountFields(actor: Actor, accountId: string, raw: unknown) {
  const patch = accountPatch.parse(raw);
  const account = await requireEditableAccount(actor, accountId);
  if (patch.ownerMembershipId !== undefined && can(actor, "accounts:edit")?.scope !== "ALL") {
    throw new ForbiddenError("accounts:edit");
  }
  const db = scopedDb(actor);
  if (patch.ownerMembershipId) {
    const owner = await db.membership.findFirst({
      where: {
        id: patch.ownerMembershipId,
        status: "ACTIVE",
        role: { in: ["ADMIN", "CS_LEADER", "CSM"] },
      },
    });
    if (!owner)
      throw new AccountInputError("Choose an active admin, CS leader or CSM as the owner.");
  }
  return db.$tenantTransaction(async (tx) => {
    const before = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
    const data: Prisma.AccountUncheckedUpdateInput = {};
    if (patch.ownerMembershipId !== undefined) data.ownerMembershipId = patch.ownerMembershipId;
    if (patch.lifecycleStage && patch.lifecycleStage !== before.lifecycleStage) {
      data.lifecycleStage = patch.lifecycleStage;
      data.stageChangedAt = new Date();
    }
    if (patch.tier === "RULE") data.tierSource = "RULE";
    else if (patch.tier) Object.assign(data, { tier: patch.tier, tierSource: "MANUAL" });
    await tx.account.update({ where: { id: accountId }, data });
    if (patch.tier === "RULE") await applyTierRule(tx, actor.workspaceId, accountId);
    const after = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
    const pick = (a: typeof before) => ({
      ownerMembershipId: a.ownerMembershipId,
      tier: a.tier,
      tierSource: a.tierSource,
      lifecycleStage: a.lifecycleStage,
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "account.updated",
        targetType: "Account",
        targetId: accountId,
        summary: `Updated ${account.name}`,
        before: pick(before),
        after: pick(after),
      },
      tx,
    );
    return after;
  });
}

// ─── Missing-data helper (spec §6A5) ─────────────────────────────────────────

/**
 * The one missing-data question for this viewer on this account, or null. Showing it records
 * who was asked and when (that is what the daily limit counts). Never blocks anything.
 */
export async function getMissingDataQuestion(actor: Actor, accountId: string, now = new Date()) {
  const account = await getAccount(actor, accountId);
  if (!account || !account.canEdit) return null;
  const db = scopedDb(actor);
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const [settings, contract, contacts, keyRole, prompts, askedToday] = await Promise.all([
    getSettingsData(actor.workspaceId),
    db.contract.findFirst({
      where: { accountId, status: "ACTIVE", startDate: { lte: now } },
      orderBy: { startDate: "desc" },
      select: { renewalDate: true },
    }),
    db.contact.count({ where: { accountId } }),
    db.stakeholderRole.count({ where: { accountId, role: "CHAMPION", validTo: null } }),
    db.missingDataPrompt.findMany({ where: { accountId } }),
    db.missingDataPrompt.count({
      where: { askedMembershipId: actor.membershipId, askedAt: { gte: dayStart } },
    }),
  ]);
  const next = nextMissingQuestion({
    facts: {
      accountId,
      tier: account.tier,
      ownerMembershipId: account.ownerMembershipId,
      hasCurrentContract: contract !== null,
      renewalDateMissing: contract !== null && contract.renewalDate === null,
      hasContacts: contacts > 0,
      hasKeyContact: keyRole > 0,
    },
    viewer: actor,
    prompts: prompts.map((p) => ({
      field: p.field,
      answeredAt: p.answeredAt,
      snoozeUntil: p.snoozeUntil,
      askedToday:
        p.askedMembershipId === actor.membershipId && p.askedAt !== null && p.askedAt >= dayStart,
    })),
    askedTodayByViewer: askedToday,
    settings: settings.missingData,
    now,
  });
  if (!next) return null;
  await db.missingDataPrompt.upsert({
    where: {
      workspaceId_accountId_field: { workspaceId: actor.workspaceId, accountId, field: next.field },
    },
    create: {
      workspaceId: actor.workspaceId,
      accountId,
      field: next.field,
      askedMembershipId: actor.membershipId,
      askedAt: now,
    },
    update: { askedMembershipId: actor.membershipId, askedAt: now },
  });
  return { ...next, snoozeDays: settings.missingData.snoozeDays };
}

/** Skip: the same question is not asked again on this account until the snooze ends. */
export async function skipMissingData(
  actor: Actor,
  accountId: string,
  field: MissingField,
  now = new Date(),
) {
  await requireEditableAccount(actor, accountId);
  const settings = await getSettingsData(actor.workspaceId);
  const snoozeUntil = new Date(now.getTime() + settings.missingData.snoozeDays * 86_400_000);
  await scopedDb(actor).missingDataPrompt.upsert({
    where: { workspaceId_accountId_field: { workspaceId: actor.workspaceId, accountId, field } },
    create: {
      workspaceId: actor.workspaceId,
      accountId,
      field,
      askedMembershipId: actor.membershipId,
      askedAt: now,
      skippedAt: now,
      snoozeUntil,
    },
    update: { skippedAt: now, snoozeUntil },
  });
}

/** Marks the question answered (the caller has already saved the answer through its service). */
export async function markMissingDataAnswered(
  actor: Actor,
  accountId: string,
  field: MissingField,
  now = new Date(),
) {
  await scopedDb(actor).missingDataPrompt.upsert({
    where: { workspaceId_accountId_field: { workspaceId: actor.workspaceId, accountId, field } },
    create: {
      workspaceId: actor.workspaceId,
      accountId,
      field,
      answeredAt: now,
      answeredByMembershipId: actor.membershipId,
    },
    update: { answeredAt: now, answeredByMembershipId: actor.membershipId, snoozeUntil: null },
  });
}

// ─── Data quality (spec §6A6, D-49): implemented in data-quality-service.ts ──
export {
  applyDataQualityFixes,
  dismissDataQualityIssue,
  listDataQualityIssues,
  previewDataQualityFixes,
  runDataQualityScan,
} from "./data-quality-service";
