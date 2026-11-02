"use server";

import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setChampionInput } from "../schemas";
import { setChampion } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

export async function setChampionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) return { error: "You're not a member of this workspace." };
  const parsed = setChampionInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "That contact could not be found." };
  try {
    await setChampion(ctx, parsed.data);
    revalidatePath(`/accounts/${parsed.data.accountId}`, "layout");
    return { ok: "Champion updated." };
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: "You can't edit this account." };
    if (error instanceof Error && error.name === "AccountNotFoundError")
      return { error: "That contact could not be found." };
    logger.error({ err: error }, "set champion failed");
    return { error: "Something went wrong. Nothing was changed." };
  }
}
