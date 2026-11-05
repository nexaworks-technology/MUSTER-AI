"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { decideFromAsk } from "../cards";
import { threadAttachmentIds } from "../files";
import { AskFileNotInThreadError, AskThreadNotFoundError, askQuestion } from "../loop";

/** Server Actions for /ask. The asker is always the signed-in member; nothing here is client-trusted. */
export interface AskActionState {
  error?: string;
  ok?: string;
}

const questionForm = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Type a question first.")
    .max(2000, "Keep it under 2000 characters."),
  threadId: z.string().min(1).optional(),
});

async function actor() {
  return resolveWorkspaceContext(await requireSession());
}

export async function askAction(_prev: AskActionState, fd: FormData): Promise<AskActionState> {
  const a = await actor();
  if (!a) return { error: "You're not a member of this workspace." };
  const parsed = questionForm.safeParse({
    question: fd.get("question"),
    threadId: fd.get("threadId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That isn't valid." };
  let threadId: string;
  try {
    const fileIds = parsed.data.threadId ? await threadAttachmentIds(a, parsed.data.threadId) : [];
    const res = await askQuestion(a, { ...parsed.data, ...(fileIds.length ? { fileIds } : {}) });
    threadId = res.threadId;
  } catch (e) {
    if (e instanceof AskThreadNotFoundError || e instanceof AskFileNotInThreadError)
      return { error: e.message };
    logger.error({ err: e }, "ask failed");
    return { error: "I could not answer that. Nothing was changed. Try again." };
  }
  revalidatePath(`/ask/${threadId}`);
  redirect(`/ask/${threadId}`);
}

/** Yes / No on a confirmation card: approvals.approve() / reject() as the viewer, nothing else. */
export async function decideCardAction(
  _prev: AskActionState,
  fd: FormData,
): Promise<AskActionState> {
  const a = await actor();
  if (!a) return { error: "You're not a member of this workspace." };
  const input = z
    .object({ approvalId: z.string().min(1), decision: z.enum(["yes", "no"]) })
    .safeParse(Object.fromEntries(fd));
  if (!input.success) return { error: "That isn't valid." };
  try {
    const r = await decideFromAsk(a, input.data);
    revalidatePath("/ask", "layout");
    revalidatePath("/approvals");
    const executed = r.changes
      ? ` ${r.changes.executed} change${r.changes.executed === 1 ? "" : "s"} made.`
      : "";
    return {
      ok: input.data.decision === "yes" ? `Approved.${executed}` : "Declined. Nothing was changed.",
    };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "You don't have permission to decide this." };
    if (e instanceof Error && ["ApprovalNotFoundError", "ApprovalStateError"].includes(e.name))
      return { error: e.message };
    logger.error({ err: e }, "ask card decision failed");
    return { error: "Not saved. Try again." };
  }
}
