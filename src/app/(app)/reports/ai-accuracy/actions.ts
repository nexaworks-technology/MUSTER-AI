"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { killRule, tuneRule } from "@/modules/outcomes/service";

export interface AccuracyActionState {
  ok?: string;
  error?: string;
}

function fail(error: unknown): AccuracyActionState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "That isn't valid." };
  if (error instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  if (error instanceof Error && error.name === "RuleSettingsError") return { error: error.message };
  logger.error({ err: error }, "ai accuracy rule action failed");
  return { error: "Not saved. Try again." };
}

const refresh = () => {
  revalidatePath("/reports/ai-accuracy");
  revalidatePath("/settings/signals");
};

const ruleKeySchema = z.string().min(1).max(100);

/** Tune: numeric thresholds `p.<path>` for one rule, via the audited updateRuleSettings. */
export async function tuneRuleAction(
  _prev: AccuracyActionState,
  formData: FormData,
): Promise<AccuracyActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const ruleKey = ruleKeySchema.parse(formData.get("ruleKey"));
    const numeric: Record<string, number> = {};
    for (const [k, v] of formData.entries()) {
      if (!k.startsWith("p.")) continue;
      const n = Number(v);
      if (String(v).trim() === "" || Number.isNaN(n))
        return { error: `Enter a number for ${k.slice(2).split(".").join(" › ")}.` };
      numeric[k.slice(2)] = n;
    }
    if (Object.keys(numeric).length === 0) return { error: "Nothing to change." };
    await tuneRule(actor, ruleKey, numeric);
    refresh();
    return { ok: "Saved. This creates a new rule version." };
  } catch (error) {
    return fail(error);
  }
}

/** Kill: switch the rule off (after the confirm step). Nothing is deleted; it can be switched back on. */
export async function killRuleAction(
  _prev: AccuracyActionState,
  formData: FormData,
): Promise<AccuracyActionState> {
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return { error: "You're not a member of this workspace." };
    const ruleKey = ruleKeySchema.parse(formData.get("ruleKey"));
    if (formData.get("confirm") !== "yes") return { error: "Confirm to switch this rule off." };
    await killRule(actor, ruleKey);
    refresh();
    return { ok: "Rule switched off." };
  } catch (error) {
    return fail(error);
  }
}
