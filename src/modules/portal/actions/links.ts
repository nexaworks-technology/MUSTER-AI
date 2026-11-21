"use server";

import { revalidatePath } from "next/cache";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { AccountNotFoundError } from "@/modules/accounts/service";
import { issuePortalLink, revokePortalLink } from "../service";

/**
 * Account › Plans › Customer portal (DEMO-WALKTHROUGH FAIL 37). The link is returned to the person
 * who issued it, once; nothing is sent to the customer from here (Rule 3). Server-side checks only:
 * the service re-checks that the member may edit the account and that the contact is on it.
 */
export interface PortalLinkState {
  error?: string;
  url?: string;
  contactName?: string;
  expiresAt?: string;
}

const refusal = (e: unknown): string =>
  e instanceof ForbiddenError || e instanceof AccountNotFoundError
    ? "You can't give portal access on this account."
    : e instanceof Error && /email|not a contact/.test(e.message)
      ? e.message
      : "The link could not be created. Nothing was changed.";

export async function issuePortalLinkAction(
  _prev: PortalLinkState,
  fd: FormData,
): Promise<PortalLinkState> {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) return { error: "You're not a member of this workspace." };
  const accountId = String(fd.get("accountId") ?? "");
  try {
    const out = await issuePortalLink(c, { accountId, contactId: fd.get("contactId") });
    revalidatePath(`/accounts/${accountId}/plans`);
    return {
      url: out.url,
      contactName: out.contactName,
      expiresAt: out.expiresAt.toISOString(),
    };
  } catch (e) {
    logger.warn({ err: e }, "portal link not issued");
    return { error: refusal(e) };
  }
}

export async function revokePortalLinkAction(fd: FormData): Promise<void> {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) return;
  const accountId = String(fd.get("accountId") ?? "");
  try {
    await revokePortalLink(c, { accountId, portalAccessId: fd.get("portalAccessId") });
  } catch (e) {
    logger.warn({ err: e }, "portal link not revoked");
  }
  revalidatePath(`/accounts/${accountId}/plans`);
}
