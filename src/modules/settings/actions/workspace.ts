"use server";

import { revalidatePath } from "next/cache";
import { workspaceProfileInput } from "../schemas";
import { updateWorkspaceProfile } from "../service";
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
