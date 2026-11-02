import type { BookScope, Prisma } from "@prisma/client";
import { can, requirePermission, type Grant } from "@/lib/auth/permissions";
import type { WorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";
import { PAGE_SIZE, type AccountListQuery } from "./schemas";

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
}

export interface AccountListPage {
  rows: AccountListRow[];
  total: number;
  offset: number;
  nextCursor: string | null;
  prevCursor: string | null;
  arrVisible: boolean;
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
  const where = listWhere(actor, grant, query);
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
