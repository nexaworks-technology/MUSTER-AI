"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { draftCheckIn } from "../checkin";

export interface CheckInActionState {
  error?: string;
  info?: string;
}

/** Draft check-in: on success the CSM lands on the new approval; nothing is sent from here. */
export async function draftCheckInAction(
  _prev: CheckInActionState,
  fd: FormData,
): Promise<CheckInActionState> {
  let approvalId: string | null = null;
  try {
    const a = await resolveWorkspaceContext(await requireSession());
    if (!a) return { error: "You're not a member of this workspace." };
    const r = await draftCheckIn(a, Object.fromEntries(fd));
    if (r.status === "DRAFTED") approvalId = r.approvalId;
    else if (r.status === "NOT_CONFIGURED")
      return { info: "AI is not configured. Write the email yourself below." };
    else if (r.status === "NO_DRAFT")
      return {
        info: `The AI found nothing it could say from these records${r.missing.length ? ` (missing: ${r.missing.join("; ")})` : ""}. Write it yourself if you want to.`,
      };
    else
      return {
        error: `The AI draft did not succeed (${r.runStatus.toLowerCase().replaceAll("_", " ")}); nothing was saved from it. Write it yourself below.`,
      };
  } catch (e) {
    if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? "That isn't valid." };
    if (e instanceof ForbiddenError)
      return { error: "You can draft check-ins only for accounts you can edit." };
    if (
      e instanceof Error &&
      ["CheckInError", "AccountNotFoundError", "ApprovalStateError"].includes(e.name)
    )
      return { error: e.message };
    logger.error({ err: e }, "draft check-in failed");
    return { error: "Not saved. Try again." };
  }
  redirect(`/approvals/${approvalId}`);
}
