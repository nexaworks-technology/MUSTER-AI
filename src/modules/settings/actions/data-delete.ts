"use server";

import { revalidatePath } from "next/cache";
import { cancelDeletion, DeletionError, requestDeletion } from "../service";
import { actorOrRedirect, toFormError, type FormState } from "./shared";

/** Settings › Data › Delete this workspace (M12 B2). Admin only (checked in the service). */
export async function requestDeletionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    const { purgeAfter } = await requestDeletion(actor, {
      confirmName: String(fd.get("confirmName") ?? ""),
    });
    revalidatePath("/settings/data");
    return {
      ok: `Deletion scheduled. Everything is removed after ${purgeAfter.toISOString().slice(0, 10)} unless you cancel before then.`,
    };
  } catch (error) {
    if (error instanceof DeletionError) return { error: error.message };
    return toFormError(error);
  }
}

export async function cancelDeletionAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    await cancelDeletion(actor);
    revalidatePath("/settings/data");
    return { ok: "Deletion cancelled. Nothing was removed." };
  } catch (error) {
    return toFormError(error);
  }
}
