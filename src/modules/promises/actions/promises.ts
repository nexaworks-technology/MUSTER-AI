"use server";

import { revalidatePath } from "next/cache";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { todayIn } from "@/lib/dates";
import { logger } from "@/lib/logger";
import {
  PromiseEvidenceError,
  PromiseInputError,
  createPromise,
  markPromiseKeptWithNote,
  setPromiseOwner,
} from "../service";

const id = z.string().min(1).max(64);
const back = z
  .string()
  .regex(/^\/(promises|accounts\/[A-Za-z0-9_-]{1,64}\/promises)$/)
  .catch("/promises");

async function ctx() {
  const c = await resolveWorkspaceContext(await requireSession());
  if (!c) throw new ForbiddenError("accounts:edit");
  return c;
}

function message(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues[0]?.message ?? "Check the form and try again.";
  if (e instanceof PromiseInputError || e instanceof PromiseEvidenceError) return e.message;
  if (e instanceof ForbiddenError) return "You can't change promises.";
  logger.error({ err: e }, "promise action failed");
  return "Something went wrong. Nothing was changed.";
}

async function run(
  formData: FormData,
  work: (c: Awaited<ReturnType<typeof ctx>>, raw: Record<string, string>) => Promise<void>,
  done: string,
): Promise<void> {
  const raw = Object.fromEntries([...formData].filter(([, v]) => typeof v === "string")) as Record<
    string,
    string
  >;
  const to = back.parse(raw.returnTo);
  let error: string | null = null;
  try {
    await work(await ctx(), raw);
    revalidatePath("/promises");
    revalidatePath(to);
  } catch (e) {
    error = message(e);
  }
  redirect((error ? `${to}?error=${encodeURIComponent(error)}` : `${to}?done=${done}`) as Route);
}

export async function createPromiseAction(formData: FormData): Promise<void> {
  await run(
    formData,
    async (c, raw) => {
      const input = z
        .object({
          accountId: id,
          what: z.string(),
          party: z.enum(["US", "CUSTOMER"]),
          dueDate: z.string().optional(),
          ownerMembershipId: z.string().optional(),
        })
        .parse(raw);
      await createPromise(c, {
        accountId: input.accountId,
        what: input.what,
        party: input.party,
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ownerMembershipId: input.ownerMembershipId || null,
        today: todayIn(c.workspace.timezone),
      });
    },
    "created",
  );
}

export async function setPromiseOwnerAction(formData: FormData): Promise<void> {
  await run(
    formData,
    async (c, raw) => {
      const input = z
        .object({ promiseId: id, ownerMembershipId: z.string().optional() })
        .parse(raw);
      await setPromiseOwner(c, {
        promiseId: input.promiseId,
        ownerMembershipId: input.ownerMembershipId || null,
      });
    },
    "owner",
  );
}

export async function markPromiseKeptAction(formData: FormData): Promise<void> {
  await run(
    formData,
    async (c, raw) => {
      const input = z.object({ promiseId: id, text: z.string() }).parse(raw);
      await markPromiseKeptWithNote(c, { ...input, today: todayIn(c.workspace.timezone) });
    },
    "kept",
  );
}
