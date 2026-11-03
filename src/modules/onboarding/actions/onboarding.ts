"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { AccountNotFoundError } from "@/modules/accounts/service";
import {
  archiveTemplate,
  createPlan,
  markStepDone,
  OnboardingError,
  removeStep,
  saveTemplate,
  updateStep,
} from "../plans.service";
import { condition, templateStep } from "../schemas";

/**
 * Onboarding actions. Every service re-checks permission and book scope; known failures come back
 * as a short plain message on the same page.
 */
async function actor() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  return ctx;
}

async function run(page: string, fn: () => Promise<string>): Promise<never> {
  let q: string;
  try {
    q = `ok=${encodeURIComponent(await fn())}`;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof AccountNotFoundError) notFound();
    if (e instanceof OnboardingError) q = `error=${encodeURIComponent(e.message)}`;
    else if (e instanceof z.ZodError)
      q = `error=${encodeURIComponent(e.issues[0]?.message ?? "Check the form.")}`;
    else throw e;
  }
  revalidatePath(page);
  redirect(`${page}?${q}` as Route);
}

const id = z.string().min(1).max(60);
const accountPage = (accountId: string) => `/accounts/${id.parse(accountId)}/onboarding`;

export async function createPlanAction(accountId: string) {
  return run(accountPage(accountId), async () => {
    await createPlan(await actor(), id.parse(accountId));
    return "Onboarding plan started.";
  });
}

export async function markStepDoneAction(accountId: string, stepId: string) {
  return run(accountPage(accountId), async () => {
    await markStepDone(await actor(), id.parse(stepId));
    return "Step marked done.";
  });
}

export async function blockStepAction(accountId: string, stepId: string, formData: FormData) {
  return run(accountPage(accountId), async () => {
    const reason = String(formData.get("blockedReason") ?? "").trim();
    await updateStep(await actor(), id.parse(stepId), { blockedReason: reason || null });
    return reason ? "Blocked reason saved." : "Step unblocked.";
  });
}

export async function dueDateAction(accountId: string, stepId: string, formData: FormData) {
  return run(accountPage(accountId), async () => {
    await updateStep(await actor(), id.parse(stepId), {
      dueDate: String(formData.get("dueDate") ?? ""),
    });
    return "Due date changed.";
  });
}

export async function removeStepAction(accountId: string, stepId: string) {
  return run(accountPage(accountId), async () => {
    await removeStep(await actor(), id.parse(stepId));
    return "Step removed.";
  });
}

const TEMPLATES = "/settings/onboarding-templates";

/**
 * Template form: steps one per line as "Title | us or customer | day", value conditions from the
 * known metrics (up to three rows of metric + numbers).
 */
function stepsFrom(text: string) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const [title = "", side = "", day = ""] = line.split("|").map((x) => x.trim());
      const key =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 40) || `step_${i + 1}`;
      return templateStep.parse({
        key,
        title,
        ownerSide: side.toLowerCase().startsWith("c") ? "CUSTOMER" : "US",
        dueDay: Number(day.replace(/[^0-9]/g, "")),
      });
    });
}

function conditionsFrom(fd: FormData) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const metric = String(fd.get(`metric${i}`) ?? "");
    if (!metric) continue;
    const n = Number(fd.get(`value${i}`) ?? 0);
    const days = Number(fd.get(`days${i}`) || 1);
    const featureKey = String(fd.get(`feature${i}`) ?? "");
    out.push(
      condition.parse(
        metric === "featureUsed"
          ? { metric, featureKey, minDays: Math.max(1, n) }
          : metric === "keyFeaturesUsed"
            ? { metric, min: n }
            : metric === "activeSeatShare"
              ? { metric, min: n / 100, days }
              : { metric, min: n, days },
      ),
    );
  }
  return out;
}

export async function saveTemplateAction(templateId: string | null, formData: FormData) {
  return run(TEMPLATES, async () => {
    const tier = String(formData.get("forTier") ?? "");
    await saveTemplate(
      await actor(),
      {
        name: String(formData.get("name") ?? ""),
        forTier: tier || null,
        forPlan: String(formData.get("forPlan") ?? "").trim() || null,
        targetDays: Number(formData.get("targetDays") ?? 0),
        steps: stepsFrom(String(formData.get("steps") ?? "")),
        valueDefinition: conditionsFrom(formData),
      },
      templateId ?? undefined,
    );
    return "Template saved.";
  });
}

export async function archiveTemplateAction(templateId: string) {
  return run(TEMPLATES, async () => {
    await archiveTemplate(await actor(), id.parse(templateId));
    return "Template archived.";
  });
}
