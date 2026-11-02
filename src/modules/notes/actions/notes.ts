"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import type { createNoteInput } from "../schemas";
import { createNote } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

export async function createNoteAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const { note, notified, notNotified } = await createNote(
      actor,
      Object.fromEntries(formData) as z.input<typeof createNoteInput>,
    );
    revalidatePath(`/accounts/${note.accountId}`, "layout");
    const parts = ["Note saved."];
    if (notified > 0)
      parts.push(`${notified} ${notified === 1 ? "person was" : "people were"} notified.`);
    if (notNotified.length > 0)
      parts.push(`Not notified (can't see this account): ${notNotified.join(", ")}.`);
    return { ok: parts.join(" ") };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "Check the note and try again." };
    if (error instanceof ForbiddenError) return { error: "You can't add notes to this account." };
    if (error instanceof Error && /NotFound/.test(error.name))
      return { error: "That account could not be found." };
    logger.error({ err: error }, "note action failed");
    return { error: "Something went wrong. The note was not saved." };
  }
}
