"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { setRenewalDate } from "@/modules/billing/service";
import { setChampion } from "@/modules/contacts/service";
import { markMissingDataAnswered, skipMissingData, updateAccountFields } from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

const input = z.object({
  accountId: z.string().min(1),
  field: z.enum(["OWNER", "RENEWAL_DATE", "KEY_CONTACT"]),
  intent: z.enum(["answer", "skip"]),
  value: z.string().optional(),
});

export async function missingDataAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const { accountId, field, intent, value } = input.parse(Object.fromEntries(formData));
    if (intent === "skip") {
      await skipMissingData(actor, accountId, field);
    } else {
      if (!value) return { error: "Choose an answer, or press Skip." };
      if (field === "RENEWAL_DATE")
        await setRenewalDate(
          actor,
          accountId,
          z.coerce.date({ message: "Use a valid renewal date" }).parse(value),
        );
      else if (field === "OWNER")
        await updateAccountFields(actor, accountId, { ownerMembershipId: value });
      else await setChampion(actor, { accountId, contactId: value });
      await markMissingDataAnswered(actor, accountId, field);
    }
    revalidatePath(`/accounts/${accountId}`, "layout");
    return { ok: intent === "skip" ? "Skipped." : "Thanks — saved." };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: error.issues[0]?.message ?? "That answer isn't valid." };
    if (error instanceof ForbiddenError) return { error: "You can't change this account." };
    if (
      error instanceof Error &&
      (error.name === "AccountInputError" || error.name === "AccountNotFoundError")
    )
      return { error: error.message };
    logger.error({ err: error }, "missing-data action failed");
    return { error: "Not saved. Try again." };
  }
}
