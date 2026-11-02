import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { getAccount } from "@/modules/accounts/service";

/**
 * Account 360 layout and tab pages render concurrently, so each calls this. React `cache` makes
 * it one lookup per request. Another workspace's id, or one outside the book, is a 404.
 */
export const loadAccount = cache(async (accountId: string) => {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const account = await getAccount(ctx, accountId);
  if (!account) notFound();
  return { ctx, account };
});
