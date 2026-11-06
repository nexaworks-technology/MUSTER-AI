import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { closeRateLimit } from "@/lib/rate-limit";
import { createTestAdmin } from "@/test/fixtures";
import { AUTH_FAILURE_BLOCK, LIMITS } from "../guard";

/**
 * M12 A9 — every named control proven by a refusal through the real route or action:
 * webhook streaming cap (413 without Content-Length), usage API and upload routes blocking an IP
 * after repeated 401s (429), sign-in per-email limit, invitation per-IP limit, Ask AI per-member
 * limit, and the portal's per-IP limit. Each test uses its own IP so the windows don't collide.
 */
let currentIp = "203.0.113.1";
let sessionToken: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": currentIp }),
  cookies: async () => ({
    get: (n: string) =>
      sessionToken && n === "authjs.session-token" ? { value: sessionToken } : undefined,
    getAll: () => (sessionToken ? [{ name: "authjs.session-token", value: sessionToken }] : []),
    set: () => undefined,
    delete: () => undefined,
    has: () => Boolean(sessionToken),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/config", async () => {
  const { AuthError } = await import("next-auth");
  return {
    signIn: async () => {
      throw new AuthError("CredentialsSignin");
    },
    signOut: async () => undefined,
    auth: async () => null,
  };
});
const freshIp = () =>
  `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

afterAll(async () => {
  await closeRateLimit();
});

function chunkedPost(url: string, bytes: number, headers: Record<string, string> = {}) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      sent += 4096;
      c.enqueue(new Uint8Array(4096).fill(120));
    },
  });
  return new Request(url, { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("routes", () => {
  it("webhook: a chunked body over 1 MB with no Content-Length is refused 413", async () => {
    const { POST } =
      await import("@/app/api/integrations/[provider]/webhook/[integrationId]/route");
    const res = await POST(
      chunkedPost("http://localhost/w", 3_000_000, { "x-forwarded-for": freshIp() }),
      {
        params: Promise.resolve({ provider: "hubspot", integrationId: randomUUID() }),
      },
    );
    expect(res.status).toBe(413);
  });

  it("usage API: an IP sending bad keys is blocked with 429 after the 401 limit", async () => {
    const { handleUsageRequest } = await import("@/modules/integrations/usage-api/route-handler");
    const ip = freshIp();
    const call = () =>
      handleUsageRequest(
        new Request("http://localhost/api/usage/v1/track", {
          method: "POST",
          headers: {
            authorization: "Bearer nxu_bad",
            "x-forwarded-for": ip,
            "content-type": "application/json",
          },
          body: JSON.stringify({ event: "x", userId: "u" }),
        }),
        "track",
      );
    for (let i = 0; i < AUTH_FAILURE_BLOCK.limit; i++) expect((await call()).status).toBe(401);
    expect((await call()).status).toBe(429);
  });

  it("upload route: unauthenticated calls count as 401s and the IP is then refused 429", async () => {
    const { POST } = await import("@/app/api/files/route");
    sessionToken = null;
    const ip = freshIp();
    const call = () =>
      POST(
        new Request("http://localhost/api/files", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
        }),
      );
    for (let i = 0; i < AUTH_FAILURE_BLOCK.limit; i++) expect((await call()).status).toBe(401);
    expect((await call()).status).toBe(429);
  });
});

describe("actions and token pages", () => {
  it(`sign-in: the ${LIMITS.signInPerEmail.limit + 1}th attempt for one email is refused`, async () => {
    const { signInWithPassword } = await import("@/app/sign-in/actions");
    currentIp = freshIp();
    const email = `limit-${randomUUID().slice(0, 8)}@example.test`;
    const fd = () => {
      const f = new FormData();
      f.set("email", email);
      f.set("password", "wrong");
      return f;
    };
    for (let i = 0; i < LIMITS.signInPerEmail.limit; i++)
      expect((await signInWithPassword({}, fd())).error).toMatch(/don't match/);
    expect((await signInWithPassword({}, fd())).error).toMatch(/Too many attempts/);
  });

  it(`invitation accept: refused after ${LIMITS.invitationPerIp.limit} attempts from one IP`, async () => {
    const { acceptInviteAsExistingUserAction } =
      await import("@/modules/settings/actions/invitations");
    currentIp = freshIp();
    // Past the limit check, a signed-out caller is redirected to sign in: that is "let through".
    const attempt = async () =>
      (await acceptInviteAsExistingUserAction({}, new FormData()).catch((e: unknown) => ({
        error: e instanceof Error && e.message === "NEXT_REDIRECT" ? "redirected" : String(e),
      }))) as { error?: string };
    for (let i = 0; i < LIMITS.invitationPerIp.limit; i++)
      expect((await attempt()).error ?? "").not.toMatch(/Too many attempts/);
    expect((await attempt()).error).toMatch(/Too many attempts/);
  });

  it(`portal: refused after ${LIMITS.portalPerIp.limit} requests from one IP`, async () => {
    const Page = (await import("@/app/portal/[token]/page")).default;
    currentIp = freshIp();
    const render = async () =>
      JSON.stringify(await Page({ params: Promise.resolve({ token: "x".repeat(64) }) }));
    for (let i = 0; i < Math.min(LIMITS.portalPerIp.limit, AUTH_FAILURE_BLOCK.limit); i++)
      expect(await render()).not.toMatch(/Too many attempts/);
    // bad tokens count as auth failures, so the IP is blocked by the 401 rule at the latest
    expect(await render()).toMatch(/Too many attempts/);
  });

  describe("Ask AI", () => {
    let token: string;
    beforeAll(async () => {
      const { actor } = await createTestAdmin("AskLimit");
      token = `lim-${randomBytes(12).toString("hex")}`;
      await rawDb.session.create({
        data: {
          sessionToken: token,
          userId: actor.userId,
          expires: new Date(Date.now() + 3_600_000),
          activeWorkspaceId: actor.workspaceId,
        },
      });
    });
    it(`refuses a member's question after ${LIMITS.askPerMember.limit} in the window`, async () => {
      const { askAction } = await import("@/modules/ask-ai/actions/ask");
      sessionToken = token;
      const ask = () => {
        const f = new FormData();
        f.set("question", "hello?");
        return askAction({}, f).catch((e: unknown) => ({ error: String(e) }));
      };
      for (let i = 0; i < LIMITS.askPerMember.limit; i++) {
        const r = (await ask()) as { error?: string };
        expect(r?.error ?? "").not.toMatch(/asked a lot/);
      }
      expect(((await ask()) as { error?: string }).error).toMatch(/asked a lot/);
      sessionToken = null;
    }, 120_000);
  });
});
