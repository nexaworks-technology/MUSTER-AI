"use server";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { actionIp, noteAuthFailure, refuseAction } from "@/lib/http/action-guard";
import { LIMITS } from "@/lib/http/guard";
import { submitSurveyResponse, SurveyTokenError } from "@/modules/surveys/service";

/**
 * The public survey answer (M12 A10 — the route M10 never built). Token-only: no session. Limited
 * per IP; an invalid or expired token counts as an authentication failure against the IP.
 */
export interface SurveyFormState {
  ok?: true;
  error?: string;
}

const form = z.object({
  token: z.string().min(1).max(4096),
  score: z.coerce.number().int(),
  comment: z.string().trim().max(2000).optional(),
});

export async function submitSurveyFormAction(
  _prev: SurveyFormState,
  fd: FormData,
): Promise<SurveyFormState> {
  const ip = await actionIp();
  const refused = await refuseAction(ip, [[`survey:ip:${ip}`, LIMITS.surveyPerIp]]);
  if (refused) return { error: refused };
  const parsed = form.safeParse({
    token: fd.get("token"),
    score: fd.get("score"),
    comment: fd.get("comment") || undefined,
  });
  if (!parsed.success) return { error: "Choose a score to send." };
  try {
    await submitSurveyResponse(parsed.data);
    return { ok: true };
  } catch (e) {
    if (e instanceof SurveyTokenError) {
      await noteAuthFailure(ip);
      return { error: e.message };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { error: "This survey has already been answered. Thank you." };
    if (e instanceof Error && /already been submitted/.test(e.message))
      return { error: "This survey has already been answered. Thank you." };
    if (e instanceof Error && /score must be/i.test(e.message)) return { error: e.message };
    return { error: "Your answer could not be saved. Try again later." };
  }
}
