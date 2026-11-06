import { hitRateLimit, peekRateLimit, type RateLimit } from "@/lib/rate-limit";

/**
 * Abuse controls for public and token endpoints (M12 A9, D-176). Fixed Redis windows.
 * - Repeated 401s: an IP that failed authentication AUTH_FAILURE_BLOCK.limit times in the window
 *   is refused on every guarded endpoint until the window ends.
 * - Endpoint limits: `limitOrRefuse(key, limit)` counts and refuses past the limit.
 */
export const AUTH_FAILURE_BLOCK: RateLimit = { limit: 20, windowSeconds: 600 };

/** The limits in use (D-176); tests and DEPLOY.md read them from here. */
export const LIMITS = {
  signInPerIp: { limit: 10, windowSeconds: 600 },
  signInPerEmail: { limit: 5, windowSeconds: 600 },
  invitationPerIp: { limit: 10, windowSeconds: 600 },
  webhookPerIntegration: { limit: 600, windowSeconds: 60 },
  portalPerIp: { limit: 60, windowSeconds: 60 },
  surveyPerIp: { limit: 20, windowSeconds: 600 },
  askPerMember: { limit: 30, windowSeconds: 600 },
  uploadPerMember: { limit: 30, windowSeconds: 600 },
} satisfies Record<string, RateLimit>;

const refusal = (retryAfter: number) =>
  new Response("too many requests", {
    status: 429,
    headers: { "retry-after": String(retryAfter) },
  });

/** A 429 when this IP is blocked for repeated authentication failures, else null. */
export async function guardAuthFailures(ip: string): Promise<Response | null> {
  const r = await peekRateLimit(`authfail:${ip}`, AUTH_FAILURE_BLOCK);
  return r.used >= AUTH_FAILURE_BLOCK.limit ? refusal(r.retryAfterSeconds) : null;
}

/** Records one authentication failure (a 401) for this IP. */
export async function noteAuthFailure(ip: string): Promise<void> {
  await hitRateLimit(`authfail:${ip}`, AUTH_FAILURE_BLOCK);
}

/** Counts one request; a 429 once the key is over its limit, else null. */
export async function limitOrRefuse(key: string, limit: RateLimit): Promise<Response | null> {
  const r = await hitRateLimit(key, limit);
  return r.allowed ? null : refusal(r.retryAfterSeconds);
}

/**
 * The shared front door of an unauthenticated endpoint (M12 A9): refuse a blocked IP, read the
 * body under a streaming cap, and hand back a `done(response)` that records a 401 against the IP.
 */
export async function openPublicRequest(
  req: Request,
  maxBytes: number,
): Promise<
  | { refused: Response }
  | { refused: null; ip: string; body: string; done: (res: Response) => Promise<Response> }
> {
  const { clientIp } = await import("./client-ip");
  const { BodyTooLargeError, readCappedText, tooLarge } = await import("./body");
  const ip = clientIp(req.headers);
  const blocked = await guardAuthFailures(ip);
  if (blocked) return { refused: blocked };
  let body: string;
  try {
    body = await readCappedText(req, maxBytes);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return { refused: tooLarge() };
    throw e;
  }
  return {
    refused: null,
    ip,
    body,
    done: async (res) => {
      if (res.status === 401) await noteAuthFailure(ip);
      return res;
    },
  };
}

/**
 * Signed-in upload routes (M12 A9): an unauthenticated call counts as a 401 against the IP (and a
 * blocked IP is refused first); a member is limited per window; the multipart body is read under
 * a streaming cap. Returns the parsed form or the refusal to send.
 */
export async function openUpload(
  req: Request,
  member: { membershipId: string } | null,
  maxBytes: number,
  unauthenticated: () => Response,
): Promise<{ refused: Response } | { refused: null; form: FormData }> {
  const { clientIp } = await import("./client-ip");
  const { BodyTooLargeError, readCappedForm } = await import("./body");
  const ip = clientIp(req.headers);
  const blocked = await guardAuthFailures(ip);
  if (blocked) return { refused: blocked };
  if (!member) {
    await noteAuthFailure(ip);
    return { refused: unauthenticated() };
  }
  const limited = await limitOrRefuse(`upload:${member.membershipId}`, LIMITS.uploadPerMember);
  if (limited) return { refused: limited };
  try {
    return { refused: null, form: await readCappedForm(req, maxBytes) };
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      return { refused: Response.json({ error: "Files can be up to 25 MB." }, { status: 413 }) };
    return {
      refused: Response.json(
        { error: "The upload could not be read. Try again." },
        { status: 400 },
      ),
    };
  }
}
