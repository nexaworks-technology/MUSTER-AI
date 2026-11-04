"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import {
  duplicatePlay,
  killPlay,
  pausePlay,
  PlayNotFoundError,
  publishPlay,
  revertPlayVersion,
} from "./service";

export interface ActionState {
  ok?: string;
  error?: string;
  newPlayId?: string;
}

async function ctx() {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) throw new ForbiddenError("accounts:view");
  return c;
}

function failure(error: unknown, fallback: string): ActionState {
  if (error instanceof z.ZodError) {
    return { error: error.issues[0]?.message ?? "Check the form and try again." };
  }
  if (error instanceof ForbiddenError) {
    return { error: "You don't have permission to do that." };
  }
  if (error instanceof PlayNotFoundError) {
    return { error: "Play not found." };
  }
  if (error instanceof Error) {
    return { error: error.message };
  }
  logger.error({ err: error }, "play action failed");
  return { error: fallback };
}

export async function publishPlayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await ctx();
    const playId = z.string().min(1).parse(formData.get("playId"));
    const retroactive = formData.get("retroactive") === "true" || formData.get("retroactive") === "on";

    const result = await publishPlay(actor, playId, { retroactive });
    if (result.status === "REFUSED") {
      return { error: `Safety check refused: ${result.refusals.join("; ")}` };
    }

    revalidatePath("/plays");
    revalidatePath(`/plays/${playId}`);
    return {
      ok: result.enteredCount != null && result.enteredCount > 0
        ? `Play published. Started for ${result.enteredCount} matching accounts.`
        : "Play published.",
    };
  } catch (error) {
    return failure(error, "Failed to publish play.");
  }
}

export async function pausePlayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await ctx();
    const playId = z.string().min(1).parse(formData.get("playId"));
    await pausePlay(actor, playId);
    revalidatePath("/plays");
    revalidatePath(`/plays/${playId}`);
    return { ok: "Play paused." };
  } catch (error) {
    return failure(error, "Failed to pause play.");
  }
}

export async function killPlayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await ctx();
    const playId = z.string().min(1).parse(formData.get("playId"));
    await killPlay(actor, playId);
    revalidatePath("/plays");
    revalidatePath(`/plays/${playId}`);
    return { ok: "Play killed." };
  } catch (error) {
    return failure(error, "Failed to kill play.");
  }
}

export async function duplicatePlayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await ctx();
    const playId = z.string().min(1).parse(formData.get("playId"));
    const name = formData.get("name") ? String(formData.get("name")) : undefined;
    const duplicated = await duplicatePlay(actor, playId, { name });
    revalidatePath("/plays");
    return { ok: `Play duplicated as "${duplicated.name}".`, newPlayId: duplicated.id };
  } catch (error) {
    return failure(error, "Failed to duplicate play.");
  }
}

export async function revertPlayVersionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await ctx();
    const playId = z.string().min(1).parse(formData.get("playId"));
    const version = Number(z.string().min(1).parse(formData.get("version")));
    const reverted = await revertPlayVersion(actor, playId, version);
    revalidatePath("/plays");
    revalidatePath(`/plays/${playId}`);
    return { ok: `Reverted to version ${version} (now draft v${reverted.version}).` };
  } catch (error) {
    return failure(error, "Failed to revert play version.");
  }
}
