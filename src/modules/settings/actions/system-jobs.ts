"use server";

import { revalidatePath } from "next/cache";
import { actionIp, refuseAction } from "@/lib/http/action-guard";
import { retryJob } from "@/modules/system/service";
import { actorOrRedirect, toFormError, type FormState } from "./shared";

/** Settings › System › Jobs: retry one failed job of this workspace (Admin only, audited). */
export async function retryJobAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await actorOrRedirect();
  const limited = await refuseAction(await actionIp(), [
    [`jobretry:${actor.membershipId}`, { limit: 30, windowSeconds: 600 }],
  ]);
  if (limited) return { error: limited };
  try {
    const done = await retryJob(actor, {
      queue: String(fd.get("queue") ?? ""),
      jobId: String(fd.get("jobId") ?? ""),
    });
    if (!done) return { error: "That job is not a failed job of this workspace." };
    revalidatePath("/settings/system/jobs");
    return { ok: "Job queued to run again." };
  } catch (error) {
    return toFormError(error);
  }
}
