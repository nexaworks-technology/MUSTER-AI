"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { activateModel, ModelActivationError } from "@/modules/health/service";
import { ConnectError, runSyncNow } from "@/modules/integrations/service";
import { enqueueBacktest, enqueueWorkspaceRun } from "@/modules/signals/service";
import {
  applyProposedPlays,
  createDefaultSegments,
  goLive,
  keepDefaultModel,
  saveTierRule,
  SetupError,
  type SetupStep,
} from "../service";

/**
 * /setup actions (Admin). Each lands back on its step with a short plain result. The health model
 * is back-tested and activated by the M3 engine and services; nothing here computes a number.
 */
async function actor() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  return ctx;
}

async function step(s: SetupStep, fn: () => Promise<string>): Promise<never> {
  let q: Record<string, string>;
  try {
    q = { step: s, ok: await fn() };
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    if (e instanceof SetupError || e instanceof ConnectError || e instanceof ModelActivationError)
      q = { step: s, error: e.message };
    else if (e instanceof z.ZodError)
      q = { step: s, error: e.issues[0]?.message ?? "Check the form." };
    else throw e;
  }
  revalidatePath("/setup");
  redirect(`/setup?${new URLSearchParams(q).toString()}` as Route);
}

export async function syncIntegrationAction(integrationId: string) {
  return step("import", async () => {
    await runSyncNow(await actor(), z.string().min(1).parse(integrationId));
    return "Sync queued. Refresh in a moment to see the counts.";
  });
}

export async function saveTierRuleAction(formData: FormData) {
  return step("tiers", async () => {
    await saveTierRule(await actor(), {
      highTouchMinArr: formData.get("highTouchMinArr"),
      midTouchMinArr: formData.get("midTouchMinArr"),
    });
    return "Tier bands saved; accounts that follow the rule were re-tiered.";
  });
}

export async function createSegmentsAction() {
  return step("tiers", async () => {
    const n = await createDefaultSegments(await actor());
    return n ? `Created ${n} segment${n === 1 ? "" : "s"}.` : "The default segments already exist.";
  });
}

export async function backtestAction() {
  return step("health", async () => {
    await enqueueBacktest(await actor());
    return "Back-test started. It takes a few seconds; refresh to see the proposal.";
  });
}

export async function approveModelAction(modelId: string) {
  return step("health", async () => {
    const a = await actor();
    const m = await activateModel(a, z.string().min(1).parse(modelId));
    await enqueueWorkspaceRun(a);
    return `Health model v${m.version} is approved and active. Every account is being scored with it.`;
  });
}

export async function goLiveAction() {
  return step("live", async () => {
    const r = await goLive(await actor());
    return r.alreadyLive
      ? "This workspace is already live."
      : "You are live. The nightly run starts tonight.";
  });
}

export async function keepDefaultModelAction() {
  return step("health", async () => {
    await keepDefaultModel(await actor());
    return "Kept the default model for now. Run the back-test again once you have more renewals and churns.";
  });
}

export async function saveProposedPlaysAction(formData: FormData) {
  return step("plays", async () => {
    const keys = formData.getAll("playKeys").map((v) => v.toString());
    const n = await applyProposedPlays(await actor(), keys);
    return n ? `Created ${n} proposed play draft${n === 1 ? "" : "s"}.` : "Proposed plays are ready.";
  });
}
