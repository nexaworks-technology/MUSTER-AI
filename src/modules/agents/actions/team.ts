"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setAgentEnabled } from "../team";

export interface TeamActionState {
  ok?: string;
  error?: string;
}

/** Switch an agent on or off for this workspace (Admin; audited). */
export async function setAgentEnabledAction(
  _prev: TeamActionState,
  fd: FormData,
): Promise<TeamActionState> {
  try {
    const a = await resolveWorkspaceContext(await requireSession());
    if (!a) return { error: "You're not a member of this workspace." };
    await setAgentEnabled(a, Object.fromEntries(fd));
    revalidatePath("/settings/ai-team");
    return { ok: fd.get("enabled") === "true" ? "Switched on." : "Switched off." };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Only Admins can switch agents on or off." };
    logger.error({ err: e }, "agent switch failed");
    return { error: "Not saved. Try again." };
  }
}
