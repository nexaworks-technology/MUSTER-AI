"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setRenewalDate } from "@/modules/billing/service";
import { updateAccountFields } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

const fieldInput = z.object({
  accountId: z.string().min(1),
  field: z.enum(["ownerMembershipId", "tier", "lifecycleStage", "renewalDate"]),
  value: z.string(),
});

export async function updateAccountFieldAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const { accountId, field, value } = fieldInput.parse(Object.fromEntries(formData));
    if (field === "renewalDate") {
      const date = z.coerce.date({ message: "Use a valid renewal date" }).parse(value);
      await setRenewalDate(actor, accountId, date);
    } else {
      await updateAccountFields(actor, accountId, { [field]: value });
    }
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${accountId}`, "layout");
    return { ok: "Saved" };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "That value isn't valid." };
    if (error instanceof ForbiddenError) return { error: "You can't change this." };
    if (
      error instanceof Error &&
      (error.name === "AccountInputError" || error.name === "AccountNotFoundError")
    )
      return { error: error.message };
    logger.error({ err: error }, "inline edit failed");
    return { error: "Not saved. Try again." };
  }
}
