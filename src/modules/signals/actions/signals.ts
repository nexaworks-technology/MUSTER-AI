"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import {
  acknowledgeSignal,
  createOutsideSignal,
  markFalseAlarm,
  updateRuleSettings,
} from "../service";

export interface ActionState {
  ok?: string;
  error?: string;
}

async function actor() {
  return resolveWorkspaceContext(await requireSession());
}

function fail(error: unknown, what: string): ActionState {
  if (error instanceof z.ZodError)
    return { error: error.issues[0]?.message ?? "That isn't valid." };
  if (error instanceof ForbiddenError) return { error: "You don't have permission to do that." };
  if (
    error instanceof Error &&
    ["AccountNotFoundError", "SignalNotFoundError", "RuleSettingsError"].includes(error.name)
  )
    return { error: error.message };
  logger.error({ err: error }, `${what} failed`);
  return { error: "Not saved. Try again." };
}

const refresh = () => {
  revalidatePath("/accounts", "layout");
  revalidatePath("/health", "layout");
};

export async function signalDecisionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const { signalId, intent, reason } = z
      .object({
        signalId: z.string().min(1),
        intent: z.enum(["acknowledge", "false_alarm"]),
        reason: z.string().optional(),
      })
      .parse(Object.fromEntries(formData));
    if (intent === "acknowledge") await acknowledgeSignal(a, signalId);
    else await markFalseAlarm(a, signalId, reason ?? "");
    refresh();
    return { ok: intent === "acknowledge" ? "Acknowledged." : "Marked as a false alarm." };
  } catch (error) {
    return fail(error, "signal decision");
  }
}

/** Form fields: ruleKey, enabled ("on"), and p.<path> numbers / p.roles checkboxes. */
export async function ruleSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const ruleKey = z.string().min(1).parse(formData.get("ruleKey"));
    const params: Record<string, unknown> = {};
    for (const [k, v] of formData.entries()) {
      if (!k.startsWith("p.")) continue;
      const path = k.slice(2).split(".");
      if (path[0] === "roles") {
        ((params.roles ??= []) as string[]).push(String(v));
        continue;
      }
      let o = params;
      for (const seg of path.slice(0, -1)) o = (o[seg] ??= {}) as Record<string, unknown>;
      const n = Number(v);
      if (String(v).trim() === "" || Number.isNaN(n))
        return { error: `Enter a number for ${path.join(" › ")}.` };
      o[path.at(-1)!] = n;
    }
    await updateRuleSettings(a, ruleKey, {
      enabled: formData.get("enabled") === "on",
      params: Object.keys(params).length ? params : undefined,
    });
    revalidatePath("/settings/signals");
    return { ok: "Saved." };
  } catch (error) {
    return fail(error, "rule settings");
  }
}

export async function outsideSignalAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const a = await actor();
    if (!a) return { error: "You're not a member of this workspace." };
    const s = await createOutsideSignal(a, Object.fromEntries(formData));
    refresh();
    revalidatePath("/settings/signals");
    return { ok: `Added: ${s.title}` };
  } catch (error) {
    return fail(error, "outside signal");
  }
}
