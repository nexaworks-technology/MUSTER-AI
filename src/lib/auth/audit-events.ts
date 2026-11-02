import { headers } from "next/headers";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { readOwnMemberships } from "./identity";

/**
 * Authentication events are written to the audit log of every workspace the user is an active
 * member of: each tenant's admins see their own members' sign-ins (DECISIONS D-34).
 */
export type AuthAuditAction = "auth.signed_in" | "auth.signed_out" | "auth.failed";

const SUMMARY: Record<AuthAuditAction, string> = {
  "auth.signed_in": "Signed in",
  "auth.signed_out": "Signed out",
  "auth.failed": "Sign-in failed: wrong password",
};

export async function clientIp(): Promise<string | null> {
  try {
    const h = await headers();
    return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  } catch {
    return null; // outside a request (tests, worker)
  }
}

export async function auditAuthEvent(
  action: AuthAuditAction,
  userId: string,
  detail: { provider?: string; ip?: string | null } = {},
): Promise<void> {
  try {
    const memberships = await readOwnMemberships(userId);
    const ip = detail.ip ?? (await clientIp());
    await Promise.all(
      memberships.map((m) =>
        writeAudit({
          workspaceId: m.workspaceId,
          actorType: "USER",
          actorId: userId,
          action,
          targetType: "User",
          targetId: userId,
          summary: detail.provider ? `${SUMMARY[action]} (${detail.provider})` : SUMMARY[action],
          ip,
        }),
      ),
    );
  } catch (error) {
    // Never block sign-in on audit I/O, but make the failure visible to operators.
    logger.error({ err: error, action, userId }, "auth audit write failed");
  }
}
