"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import {
  connectWithApiKey,
  ConnectError,
  disconnect,
  testConnection,
} from "../connections.service";
import { relinkSlackMembers, runSyncNow } from "../status.service";
import { setWriteBack, WriteBackRefusedError } from "../writeback.service";

/**
 * Settings › Integrations actions (Admin only; every service re-checks `integrations:manage`).
 * Each lands back on the page with a short plain result. Keys typed into a form go straight to
 * the service, which seals them; they are never echoed, logged or put in a URL.
 */
const PAGE = "/settings/integrations";

async function actor() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) redirect("/");
  return ctx;
}

const back = (params: Record<string, string>): never =>
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}` as Route);

/** Known, plain failures come back as a message; anything else is a 404 or rethrown. */
type Result = Record<string, string>;

async function run(fn: () => Promise<Result>): Promise<never> {
  let params: Result;
  try {
    params = await fn();
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    if (e instanceof ConnectError || e instanceof WriteBackRefusedError)
      params = { error: e.message };
    else if (e instanceof z.ZodError)
      params = { error: e.issues[0]?.message ?? "Check the form and try again." };
    else throw e;
  }
  revalidatePath(PAGE);
  return back(params);
}

const id = z.string().min(1).max(60);
const apiKeyProvider = z.enum(["STRIPE", "CHARGEBEE"]);

export async function connectApiKeyAction(provider: string, formData: FormData) {
  const p = apiKeyProvider.parse(provider);
  const optional = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? undefined : v;
  };
  return run(async () => {
    await connectWithApiKey(await actor(), p, {
      apiKey: String(formData.get("apiKey") ?? ""),
      site: optional("site"),
      webhookSecret: optional("webhookSecret"),
    });
    return { connected: p.toLowerCase() };
  });
}

export async function testConnectionAction(integrationId: string) {
  return run(async (): Promise<Result> => {
    const r = await testConnection(await actor(), id.parse(integrationId));
    return r.ok ? { tested: r.message } : { error: r.message };
  });
}

export async function runSyncNowAction(integrationId: string) {
  return run(async () => {
    await runSyncNow(await actor(), id.parse(integrationId));
    return { queued: "1" };
  });
}

export async function disconnectAction(integrationId: string, formData: FormData) {
  return run(async (): Promise<Result> => {
    if (formData.get("confirm") !== "yes")
      return { error: "Tick the box to confirm the disconnect." };
    await disconnect(await actor(), id.parse(integrationId));
    return { disconnected: "1" };
  });
}

export async function writeBackAction(integrationId: string, formData: FormData) {
  return run(async () => {
    const enabled = formData.get("enabled") === "on";
    await setWriteBack(await actor(), id.parse(integrationId), {
      enabled,
      fields: enabled ? formData.getAll("fields").map(String) : [],
    });
    return { writeback: enabled ? "on" : "off" };
  });
}

export async function linkSlackMembersAction() {
  return run(async () => {
    const r = await relinkSlackMembers(await actor());
    return {
      tested: `Linked ${r.linked} Slack member${r.linked === 1 ? "" : "s"} by verified email; ${r.unmatched} not matched.`,
    };
  });
}
