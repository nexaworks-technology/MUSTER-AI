"use server";

import { revalidatePath } from "next/cache";
import { requestExport } from "../service";
import { actorOrRedirect, toFormError, type FormState } from "./shared";

/** Settings › Data › Export all data. Admin only (checked in the service). */
export async function requestExportAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const actor = await actorOrRedirect();
  try {
    await requestExport(actor);
    revalidatePath("/settings/data");
    return { ok: "Export started. Reload this page in a minute to get the link." };
  } catch (error) {
    return toFormError(error);
  }
}
