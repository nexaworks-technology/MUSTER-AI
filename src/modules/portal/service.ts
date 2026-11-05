import { randomBytes, createHash } from "node:crypto";
import { findPortalAccessByTokenHash } from "@/lib/db/token-access";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import type { PortalAccess, SuccessPlan, Document, Survey, Goal, GoalStatus } from "@prisma/client";
import { writeAudit } from "@/lib/audit";

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
  successPlans: SuccessPlan[];
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
