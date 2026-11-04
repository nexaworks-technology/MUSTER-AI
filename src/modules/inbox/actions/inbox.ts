"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { can, ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { getAgent, runAgent } from "@/modules/agents/service";
import { assignUnmatched, dismissUnmatched, InboxError } from "../service";

const assignInput = z.object({
  id: z.string().min(1).max(64),
  accountId: z.string().min(1).max(64),
});
const dismissInput = z.object({ id: z.string().min(1).max(64) });
const BACK = "/inbox/unmatched";

async function ctx() {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) throw new ForbiddenError("accounts:edit");
  return c;
}

function message(e: unknown): string {
  if (e instanceof z.ZodError) return "Choose an account first.";
  if (e instanceof ForbiddenError) return "You can't place mail on accounts.";
  if (e instanceof InboxError) return e.message;
  logger.error({ err: e }, "inbox action failed");
  return "Something went wrong. Nothing was changed.";
}

/** Put an unmatched email on an account: it becomes a conversation, the holding text is cleared, audited. */
export async function assignUnmatchedAction(formData: FormData): Promise<void> {
  let error: string | null = null;
  try {
    await assignUnmatched(await ctx(), assignInput.parse(Object.fromEntries(formData)));
    revalidatePath("/inbox");
    revalidatePath(BACK);
  } catch (e) {
    error = message(e);
  }
  redirect(error ? `${BACK}?error=${encodeURIComponent(error)}` : `${BACK}?done=assigned`);
}

export async function dismissUnmatchedAction(formData: FormData): Promise<void> {
  let error: string | null = null;
  try {
    await dismissUnmatched(await ctx(), dismissInput.parse(Object.fromEntries(formData)));
    revalidatePath(BACK);
  } catch (e) {
    error = message(e);
  }
  redirect(error ? `${BACK}?error=${encodeURIComponent(error)}` : `${BACK}?done=dismissed`);
}

const draftInput = z.object({ inboxItemId: z.string().min(1).max(64) });

/**
 * Ask the Support Risk Agent for a reply draft. The only thing that can come of it is an Approval
 * waiting for a person (Rule 3); nothing is sent from here.
 */
export async function draftReplyAction(formData: FormData): Promise<void> {
  let result = "drafted";
  try {
    const c = await ctx();
    if (!can(c, "approvals:decide")) throw new ForbiddenError("approvals:decide");
    const { inboxItemId } = draftInput.parse(Object.fromEntries(formData));
    const out = await runAgent(
      c,
      getAgent("support-risk"),
      { inboxItemId, requestedByMembershipId: c.membershipId, nonce: randomUUID() },
      { type: "inbox", id: `${inboxItemId}:${randomUUID()}` },
    );
    if (out.kind === "not_configured") result = "not_configured";
    else if (out.status !== "SUCCEEDED") result = "failed";
    revalidatePath("/inbox");
    revalidatePath("/approvals");
  } catch (e) {
    logger.error({ err: e }, "inbox draft failed");
    result = e instanceof ForbiddenError ? "forbidden" : "failed";
  }
  redirect(`/inbox?draft=${result}`);
}
