import { NextResponse } from "next/server";
import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import {
  ConnectError,
  fixtureMode,
  OAUTH_NONCE_COOKIE,
  providerParam,
  startOAuth,
} from "@/modules/integrations/service";

/**
 * GET /api/integrations/[provider]/connect — starts OAuth (Admin only). Sets the state nonce as a
 * short-lived httpOnly cookie and redirects to the provider's consent page. In fixture mode
 * (tests, e2e, demo; refused in production) the provider is recorded, so the browser goes straight
 * to our callback with the recorded code and the same signed state.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response("Sign in to connect an integration.", { status: 401 });
  const parsed = providerParam.safeParse((await params).provider);
  if (!parsed.success) return new Response("Unknown integration.", { status: 404 });
  try {
    const { url, nonce, state } = startOAuth(ctx, parsed.data);
    const target = fixtureMode()
      ? `${env().APP_URL}/api/integrations/${parsed.data.toLowerCase()}/callback?code=fixture-code&state=${encodeURIComponent(state)}`
      : url;
    const res = NextResponse.redirect(target, 302);
    res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: env().NODE_ENV === "production",
      path: "/api/integrations",
      maxAge: 600,
    });
    return res;
  } catch (error) {
    if (error instanceof ForbiddenError)
      return new Response("Only Admins can connect integrations.", { status: 403 });
    if (error instanceof ConnectError) return new Response(error.message, { status: 400 });
    logger.error({ err: error instanceof Error ? error.name : "unknown" }, "oauth start failed");
    return new Response("The connection could not be started.", { status: 500 });
  }
}
