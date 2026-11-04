"use server";

import { randomUUID } from "node:crypto";
import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { can, ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { getAgent, runAgent } from "@/modules/agents/service";

const input = z.object({
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  candidateContactId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

/** Ask Champion Guard for an introduction draft. It can only end in an Approval waiting for a person. */
export async function draftIntroAction(formData: FormData): Promise<void> {
  let accountId = "";
  let result = "drafted";
  try {
    const parsed = input.parse(Object.fromEntries(formData));
    accountId = parsed.accountId;
    const c = await resolveWorkspaceContext(await requireSession());
    if (!c || !can(c, "approvals:decide")) throw new ForbiddenError("approvals:decide");
    const n = randomUUID();
    const out = await runAgent(
      c,
      getAgent("champion-guard"),
      { ...parsed, requestedByMembershipId: c.membershipId, nonce: n },
      { type: "champion", id: `${parsed.accountId}:${n}` },
    );
    result =
      out.kind === "not_configured"
        ? "not_configured"
        : out.status === "SUCCEEDED"
          ? "drafted"
          : "failed";
    revalidatePath(`/accounts/${parsed.accountId}/people`);
    revalidatePath("/approvals");
  } catch (e) {
    logger.error({ err: e }, "champion guard draft failed");
    result = e instanceof ForbiddenError ? "forbidden" : "failed";
  }
  redirect((accountId ? `/accounts/${accountId}/people?intro=${result}` : "/accounts") as Route);
}
