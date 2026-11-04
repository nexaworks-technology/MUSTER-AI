"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import {
  createCampaign,
  executeCampaignBatch,
  scheduleCampaign,
} from "../service";

export async function createCampaignAction(formData: FormData) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "plays:createDraft")) {
    return { error: "You don't have permission to create campaigns." };
  }

  const name = formData.get("name")?.toString() ?? "";
  const segmentId = formData.get("segmentId")?.toString() ?? "";
  const subject = formData.get("subject")?.toString() ?? "";
  const body = formData.get("body")?.toString() ?? "";
  const pacePerHour = Number.parseInt(formData.get("pacePerHour")?.toString() ?? "100", 10);

  let campaignId: string;
  try {
    const campaign = await createCampaign(ctx, {
      name,
      segmentId,
      subject,
      body,
      pacePerHour,
    });
    campaignId = campaign.id;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create campaign.";
    return { error: msg };
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaignId}`);
}

export async function scheduleCampaignAction(campaignId: string, scheduledAtStr: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "plays:createDraft")) {
    return { error: "You don't have permission to schedule campaigns." };
  }

  const scheduledAt = new Date(scheduledAtStr);
  if (Number.isNaN(scheduledAt.getTime())) {
    return { error: "Invalid schedule date and time." };
  }

  try {
    await scheduleCampaign(ctx, campaignId, scheduledAt);
    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to schedule campaign." };
  }
}

export async function runCampaignBatchAction(campaignId: string) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "plays:createDraft")) {
    return { error: "You don't have permission to run campaigns." };
  }

  try {
    const result = await executeCampaignBatch(ctx, campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true, ...result };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to execute campaign batch." };
  }
}
