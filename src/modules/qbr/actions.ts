"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { LIMITS, limitOrRefuse } from "@/lib/http/guard";
import { logger } from "@/lib/logger";
import { validatePeriodLabel } from "./metrics";
import { generateQbr } from "./service";

/**
 * Server Action for /meetings/qbr/new (M12 Session C, C0a). It calls the existing `generateQbr`
 * as the signed-in member: tenancy and revenue visibility are exactly what that backend enforces
 * (workspace-scoped reads, the member's `canViewRevenue` on the revenue metric). Nothing is
 * client-trusted. On success the member lands on the created QBR.
 */
export interface QbrActionState {
  error?: string;
}

const form = z.object({
  accountId: z.string().trim().min(1, "Pick an account."),
  period: z.string().trim().min(1, "Type a period, for example Q3 2026."),
});

export async function generateQbrAction(
  _prev: QbrActionState,
  fd: FormData,
): Promise<QbrActionState> {
  const a = await resolveWorkspaceContext(await requireSession());
  if (!a) return { error: "You're not a member of this workspace." };
  const parsed = form.safeParse({ accountId: fd.get("accountId"), period: fd.get("period") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That isn't valid." };
  const period = validatePeriodLabel(parsed.data.period);
  if (!period.valid)
    return {
      error: 'Use a period like "Q3 2026" or a date like "2026-09-30". Nothing was created.',
    };
  // A QBR makes a model call, so it shares the per-member limit Ask AI uses (M12 A9).
  if (await limitOrRefuse(`qbr:${a.membershipId}`, LIMITS.askPerMember))
    return { error: "Too many QBRs in the last few minutes. Wait a little and try again." };

  let documentId: string;
  try {
    const doc = await generateQbr(a, { accountId: parsed.data.accountId, period: period.value });
    documentId = doc.id;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.includes("not_configured"))
      return {
        error: "AI is not configured, so no QBR narrative could be written. Nothing was created.",
      };
    logger.error({ err: e }, "qbr generation failed");
    return { error: "The QBR could not be generated. Nothing was created. Try again." };
  }
  redirect(`/meetings/qbr/${documentId}`);
}
