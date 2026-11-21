import { randomBytes, createHash } from "node:crypto";
import { findPortalAccessByTokenHash } from "@/lib/db/token-access";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { PortalAccess, SuccessPlan, Document, Survey, Goal, GoalStatus } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/config/env";
import {
  AccountNotFoundError,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";

export class PortalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalAuthError";
  }
}

export interface CreatePortalAccessInput {
  accountId: string;
  contactId: string;
  expiresInDays?: number;
}

export interface CreatePortalAccessResult {
  rawToken: string;
  access: PortalAccess;
}

export interface PortalSession {
  workspaceId: string;
  accountId: string;
  contactId: string;
  portalAccessId: string;
}

export interface PortalView {
  account: { id: string; name: string };
  contact: { id: string; name: string | null; email: string | null };
  /** Shared plans with their goals (a dropped goal is no longer part of the plan). */
  successPlans: Array<SuccessPlan & { goals: Array<Pick<Goal, "id" | "text" | "status">> }>;
  qbrDocuments: Document[];
  surveys: Survey[];
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Creates a magic link PortalAccess credential for an account contact.
 * - 256-bit random cryptographic token.
 * - Stored as SHA-256 hash at rest.
 * - 14-day default expiration.
 * - CSM revocable.
 */
export async function createPortalAccess(
  ctx: TenantContext & { membershipId?: string },
  input: CreatePortalAccessInput,
): Promise<CreatePortalAccessResult> {
  const db = scopedDb(ctx);

  // Verify contact belongs to account and workspace
  const contact = await db.contact.findUniqueOrThrow({
    where: { id: input.contactId },
  });

  if (contact.accountId !== input.accountId) {
    throw new Error(`Contact ${input.contactId} does not belong to account ${input.accountId}`);
  }

  // Generate 256-bit token (32 bytes = 64 hex characters)
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  const days = input.expiresInDays ?? 14;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const access = await db.$tenantTransaction(async (tx) => {
    const row = await tx.portalAccess.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: input.accountId,
        contactId: input.contactId,
        tokenHash,
        expiresAt,
      },
    });

    if (ctx.membershipId) {
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "USER",
          actorId: ctx.membershipId,
          action: "portal.access_created",
          targetType: "PortalAccess",
          targetId: row.id,
          summary: `Created customer portal magic link for contact ${contact.email}`,
          after: { accountId: input.accountId, contactId: input.contactId, expiresAt },
        },
        tx,
      );
    }

    return row;
  });

  return { rawToken, access };
}

/**
 * Verifies a raw portal token.
 * Returns strictly scoped session: (workspaceId, accountId, contactId) from the token row.
 */
export async function verifyPortalAccess(rawToken: string): Promise<PortalSession> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    throw new PortalAuthError("Invalid portal token format.");
  }

  const tokenHash = hashToken(rawToken);

  const access = await findPortalAccessByTokenHash(tokenHash);

  if (!access) {
    throw new PortalAuthError("Invalid portal token.");
  }

  if (access.revokedAt !== null) {
    throw new PortalAuthError("Portal access has been revoked.");
  }

  if (access.expiresAt.getTime() <= Date.now()) {
    throw new PortalAuthError("Portal access token has expired.");
  }

  // Update lastUsedAt timestamp under workspace RLS
  await scopedDb({ workspaceId: access.workspaceId }).portalAccess.update({
    where: { id: access.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    workspaceId: access.workspaceId,
    accountId: access.accountId,
    contactId: access.contactId,
    portalAccessId: access.id,
  };
}

/**
 * Revokes a portal access credential.
 */
export async function revokePortalAccess(
  ctx: TenantContext & { membershipId?: string },
  portalAccessId: string,
): Promise<PortalAccess> {
  const db = scopedDb(ctx);

  return db.$tenantTransaction(async (tx) => {
    const updated = await tx.portalAccess.update({
      where: { id: portalAccessId },
      data: { revokedAt: new Date() },
    });

    if (ctx.membershipId) {
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "USER",
          actorId: ctx.membershipId,
          action: "portal.access_revoked",
          targetType: "PortalAccess",
          targetId: updated.id,
          summary: `Revoked customer portal access ${updated.id}`,
          after: { revokedAt: updated.revokedAt },
        },
        tx,
      );
    }

    return updated;
  });
}

/**
 * Loads customer portal view data for the authenticated token.
 * Scope is derived strictly from the token session — no caller argument can widen it.
 * Audited with actorType: "PORTAL_CONTACT".
 */
export async function getPortalView(rawToken: string): Promise<PortalView> {
  const session = await verifyPortalAccess(rawToken);
  const db = scopedDb({ workspaceId: session.workspaceId });

  const [account, contact, successPlans, qbrDocuments, surveys] = await Promise.all([
    db.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { id: true, name: true },
    }),
    db.contact.findUniqueOrThrow({
      where: { id: session.contactId },
      select: { id: true, name: true, email: true },
    }),
    db.successPlan.findMany({
      where: {
        accountId: session.accountId,
        sharedWithPortal: true,
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
      // The plan's goals are what the customer shares it for (DEMO-WALKTHROUGH FAIL 39).
      include: {
        goals: {
          where: { status: { not: "DROPPED" } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, text: true, status: true },
        },
      },
    }),
    db.document.findMany({
      where: {
        accountId: session.accountId,
        kind: "QBR",
        lockedAt: { not: null },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.survey.findMany({
      where: {
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Audit view by the customer contact
  await writeAudit({
    workspaceId: session.workspaceId,
    actorType: "PORTAL_CONTACT",
    actorId: session.contactId,
    action: "portal.viewed",
    targetType: "Account",
    targetId: session.accountId,
    summary: `Customer ${contact.email} viewed customer portal`,
  });

  return {
    account,
    contact,
    successPlans,
    qbrDocuments,
    surveys,
  };
}

export interface UpdatePortalGoalInput {
  goalId: string;
  status: GoalStatus;
}

/**
 * Updates a goal status via customer portal.
 * Derived strictly from token session (workspaceId, accountId, contactId).
 * Audited with actorType: "PORTAL_CONTACT".
 */
export async function updatePortalGoalProgress(
  rawToken: string,
  input: UpdatePortalGoalInput,
): Promise<Goal> {
  const session = await verifyPortalAccess(rawToken);
  const db = scopedDb({ workspaceId: session.workspaceId });

  return db.$tenantTransaction(async (tx) => {
    const goal = await tx.goal.findFirstOrThrow({
      where: { id: input.goalId, accountId: session.accountId },
    });

    const updated = await tx.goal.update({
      where: { id: goal.id },
      data: { status: input.status },
    });

    await writeAudit(
      {
        workspaceId: session.workspaceId,
        actorType: "PORTAL_CONTACT",
        actorId: session.contactId,
        action: "portal.goal_updated",
        targetType: "Goal",
        targetId: updated.id,
        summary: `Customer contact updated goal "${updated.text}" status to ${updated.status}`,
        before: { status: goal.status },
        after: { status: updated.status },
      },
      tx,
    );

    return updated;
  });
}

/**
 * Issuing portal access from the app (DEMO-WALKTHROUGH FAIL 37). Only a member who may edit the
 * account gives one of its contacts a link; the link is returned once (only its hash is stored) for
 * the person to send themselves: nothing is emailed from here (Rule 3).
 */
export const issuePortalLinkInput = z.object({
  accountId: z.string().min(1),
  contactId: z.string().min(1),
});

export async function issuePortalLink(
  actor: Actor,
  raw: unknown,
): Promise<{ url: string; expiresAt: Date; contactName: string }> {
  const input = issuePortalLinkInput.parse(raw);
  await requireEditableAccount(actor, input.accountId);
  const contact = await scopedDb(actor).contact.findFirst({
    where: { id: input.contactId, accountId: input.accountId },
    select: { id: true, name: true, email: true },
  });
  if (!contact) throw new Error("That person is not a contact on this account.");
  if (!contact.email)
    throw new Error("That person has no email on file, so the link could not be tied to them.");
  const { rawToken, access } = await createPortalAccess(actor, input);
  return {
    url: `${env().APP_URL.replace(/\/$/, "")}/portal/${rawToken}`,
    expiresAt: access.expiresAt,
    contactName: contact.name,
  };
}

export interface PortalLinkRow {
  id: string;
  contactName: string;
  contactEmail: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
}

/** The account's portal links, newest first; never the token (it is not stored). */
export async function listPortalLinks(actor: Actor, accountId: string): Promise<PortalLinkRow[]> {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const now = Date.now();
  const rows = await scopedDb(actor).portalAccess.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      contact: { select: { name: true, email: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    contactName: r.contact.name,
    contactEmail: r.contact.email,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    active: r.revokedAt === null && r.expiresAt.getTime() > now,
  }));
}

export const revokePortalLinkInput = z.object({
  accountId: z.string().min(1),
  portalAccessId: z.string().min(1),
});

/** Revokes one of this account's links; an id from another account is refused. */
export async function revokePortalLink(actor: Actor, raw: unknown): Promise<void> {
  const input = revokePortalLinkInput.parse(raw);
  await requireEditableAccount(actor, input.accountId);
  const link = await scopedDb(actor).portalAccess.findFirst({
    where: { id: input.portalAccessId, accountId: input.accountId },
    select: { id: true, revokedAt: true },
  });
  if (!link) throw new AccountNotFoundError();
  if (link.revokedAt) return;
  await revokePortalAccess(actor, link.id);
}
