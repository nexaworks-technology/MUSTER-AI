"use server";

import { randomUUID } from "node:crypto";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { AccountNotFoundError } from "@/modules/accounts/service";
import { askRenewalManager } from "@/modules/agents/service";
import {
  adoptRenewalPlan,
  PlanAdoptionValidationError,
  type PlanStepInput,
} from "@/modules/renewals/service";
import { createRenewalBrief, DocumentError } from "../service";

const id = z.string().min(1).max(60);

async function go(renewalId: string, work: () => Promise<string>) {
  const page = `/renewals/${renewalId}/brief`;
  let q: string;
  try {
    q = `ok=${encodeURIComponent(await work())}`;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof AccountNotFoundError) notFound();
    if (e instanceof DocumentError || e instanceof PlanAdoptionValidationError)
      q = `error=${encodeURIComponent(e.message)}`;
    else if (e instanceof z.ZodError)
      q = `error=${encodeURIComponent(e.issues[0]?.message ?? "Check the form.")}`;
    else throw e;
  }
  revalidatePath(page);
  redirect(`${page}?${q}` as Route);
}

/** One click: lock the metrics from the records. No model involved. */
export async function buildBriefAction(renewalId: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  await go(id.parse(renewalId), async () => {
    await createRenewalBrief(ctx, id.parse(renewalId));
    return "Brief built from the records. Its figures are locked.";
  });
}

/** Asks the Renewal Manager; its outreach goes to Approvals, never to the customer. */
export async function askRenewalManagerAction(renewalId: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  await go(id.parse(renewalId), async () => {
    const r = await askRenewalManager(ctx, { renewalId: id.parse(renewalId), nonce: randomUUID() });
    switch (r.status) {
      case "NOT_CONFIGURED":
        return "AI is not configured for this workspace, so the Renewal Manager cannot draft. You can still build the brief from the records.";
      case "DRAFTED":
        return r.approvalId
          ? "Plan written and the outreach draft is waiting in Approvals. Nothing was sent."
          : "Plan written. There was no contact to draft an email to.";
      case "NO_PLAN":
        return `The Renewal Manager had nothing to base a plan on${r.missing.length ? `: ${r.missing.join("; ")}` : ""}.`;
      default:
        return `The Renewal Manager's answer was not usable (${r.runStatus.toLowerCase().replace("_", " ")}), so nothing was written.`;
    }
  });
}

/** Human adoption of the AI-proposed plan into Renewal.planSteps (D-139). */
export async function adoptPlanAction(renewalId: string, formData: FormData) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  await go(id.parse(renewalId), async () => {
    const steps: PlanStepInput[] = [];
    let i = 0;
    while (formData.has(`step_title_${i}`)) {
      const title = (formData.get(`step_title_${i}`) as string) || "";
      const detail = (formData.get(`step_detail_${i}`) as string) || null;
      if (title.trim().length > 0) {
        steps.push({ title: title.trim(), detail: detail ? detail.trim() : null });
      }
      i++;
    }
    if (steps.length === 0 && formData.has("steps_json")) {
      try {
        const parsed = JSON.parse(formData.get("steps_json") as string);
        if (Array.isArray(parsed)) {
          steps.push(...parsed);
        }
      } catch {
        // ignore JSON parse error
      }
    }
    await adoptRenewalPlan(ctx, { renewalId: id.parse(renewalId), steps });
    return `Plan adopted (${steps.length} step${steps.length === 1 ? "" : "s"}) into renewal.`;
  });
}
