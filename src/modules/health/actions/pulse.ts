"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setPulse } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

const input = z.object({
  accountId: z.string().min(1),
  value: z.enum(["FINE", "WORRIED"]),
  comment: z.string().optional(),
});

export async function pulseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const { accountId, value, comment } = input.parse(Object.fromEntries(formData));
    await setPulse(actor, accountId, { value, comment });
    revalidatePath(`/accounts/${accountId}`, "layout");
    revalidatePath("/accounts");
    revalidatePath("/health");
    return { ok: value === "FINE" ? "Saved: Actually fine." : "Saved: Worried." };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "That Pulse isn't valid." };
    if (
      error instanceof ForbiddenError ||
      (error instanceof Error && error.name === "AccountNotFoundError")
    )
      return { error: "You can't set a Pulse on this account." };
    logger.error({ err: error }, "pulse action failed");
    return { error: "Not saved. Try again." };
  }
}
