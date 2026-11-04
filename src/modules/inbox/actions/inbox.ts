"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
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
