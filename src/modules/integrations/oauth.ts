import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { realClock, type Clock } from "@/lib/dates";

/**
 * OAuth `state` (CSRF protection, M5 §2). The state names the workspace, the member who started
 * the flow, the provider and a random nonce, and is HMAC-signed with AUTH_SECRET under its own
 * context string. The nonce is also set as an httpOnly cookie when the flow starts; the callback
 * accepts a code only when the signature, expiry, provider, member and cookie nonce all match.
 * A tampered or replayed-elsewhere state is refused before any token exchange.
 */
const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_NONCE_COOKIE = "nw_oauth_nonce";

const statePayload = z.object({
  w: z.string().min(1),
  m: z.string().min(1),
  p: z.string().min(1),
  n: z.string().min(16),
  e: z.number().int(),
});

export class OAuthStateError extends Error {
  constructor(readonly reason: string) {
    super(`OAuth state refused: ${reason}`);
    this.name = "OAuthStateError";
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`oauth-state:${body}`).digest("base64url");
}

export function newNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signState(
  s: { workspaceId: string; membershipId: string; provider: IntegrationProvider; nonce: string },
  clock: Clock = realClock,
  secret = env().AUTH_SECRET,
): string {
  const body = Buffer.from(
    JSON.stringify({
      w: s.workspaceId,
      m: s.membershipId,
      p: s.provider,
      n: s.nonce,
      e: clock().getTime() + STATE_TTL_MS,
    }),
  ).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifyState(
  state: string,
  expected: {
    workspaceId: string;
    membershipId: string;
    provider: IntegrationProvider;
    nonce: string | undefined;
  },
  clock: Clock = realClock,
  secret = env().AUTH_SECRET,
): void {
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) throw new OAuthStateError("malformed");
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got))
    throw new OAuthStateError("bad signature");
  let parsed: z.infer<typeof statePayload>;
  try {
    parsed = statePayload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    throw new OAuthStateError("malformed");
  }
  if (parsed.e < clock().getTime()) throw new OAuthStateError("expired");
  if (parsed.p !== expected.provider) throw new OAuthStateError("wrong provider");
  if (parsed.w !== expected.workspaceId || parsed.m !== expected.membershipId)
    throw new OAuthStateError("started by someone else");
  if (!expected.nonce || expected.nonce !== parsed.n)
    throw new OAuthStateError("not started in this browser");
}
