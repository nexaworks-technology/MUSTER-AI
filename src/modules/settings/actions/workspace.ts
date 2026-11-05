"use server";

import { revalidatePath } from "next/cache";
import { workspaceProfileInput } from "../schemas";
import { setVoiceDictation, updateWorkspaceProfile } from "../service";
import { actorOrRedirect, formObject, toFormError, type FormState } from "./shared";

export async function saveWorkspaceProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    await updateWorkspaceProfile(actor, workspaceProfileInput.parse(formObject(formData)));
    revalidatePath("/", "layout");
    return { ok: "Workspace saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function saveVoiceDictationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    const enabled = formData.get("voiceDictation") === "on";
    await setVoiceDictation(actor, enabled);
    revalidatePath("/ask");
    return { ok: enabled ? "Dictation is on for Ask AI." : "Dictation is off." };
  } catch (error) {
    return toFormError(error);
  }
}
