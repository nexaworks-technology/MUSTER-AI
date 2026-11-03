import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import {
  completeOAuth,
  OAUTH_NONCE_COOKIE,
  OAuthStateError,
  providerParam,
} from "@/modules/integrations/service";

/**
 * GET /api/integrations/[provider]/callback?code&state — finishes OAuth. The signed state must
 * match this member, this provider and the nonce cookie set when the flow started (CSRF); only
 * then is the code exchanged and the tokens stored sealed. Always lands back on Settings with a
 * plain result; never echoes the code, tokens or provider error bodies.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const back = (q: string) =>
    NextResponse.redirect(`${env().APP_URL}/settings/integrations?${q}`, 302);
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response("Sign in to connect an integration.", { status: 401 });
  const parsed = providerParam.safeParse((await params).provider);
  if (!parsed.success) return new Response("Unknown integration.", { status: 404 });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const jar = await cookies();
  const nonce = jar.get(OAUTH_NONCE_COOKIE)?.value;
  const provider = parsed.data.toLowerCase();
  if (!code || !state) return back(`error=declined&provider=${provider}`);
  try {
    await completeOAuth(ctx, parsed.data, { code, state, nonce });
    const res = back(`connected=${provider}`);
    res.cookies.delete({ name: OAUTH_NONCE_COOKIE, path: "/api/integrations" });
    return res;
  } catch (error) {
    if (error instanceof OAuthStateError) {
      logger.warn(
        { workspaceId: ctx.workspaceId, provider, reason: error.reason },
        "oauth state refused",
      );
      return back(`error=state&provider=${provider}`);
    }
    if (error instanceof ForbiddenError)
      return new Response("Only Admins can connect integrations.", { status: 403 });
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        provider,
        err: error instanceof Error ? error.name : "unknown",
      },
      "oauth exchange failed",
    );
    return back(`error=exchange&provider=${provider}`);
  }
}
