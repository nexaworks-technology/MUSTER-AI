import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { handlers } from "@/lib/auth/config";
import { hashPassword } from "@/lib/auth/password";
import { findSessionByToken, resolveWorkspaceContext } from "@/lib/auth/session";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestWorkspace } from "@/test/fixtures";

/**
 * D-07: email/password sign-in must produce a DATABASE session (a Session row whose token is
 * the cookie value), not a JWT. Drives the real Auth.js route handlers end to end.
 */
const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct horse battery staple";
let email: string;
let userId: string;
let workspaceId: string;

function cookiesFrom(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  return jar;
}

async function signInWith(password: string) {
  const csrfRes = await handlers.GET(new NextRequest(`${BASE}/csrf`));
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const cookie = [...cookiesFrom(csrfRes)].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await handlers.POST(
    new NextRequest(`${BASE}/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({
        email,
        password,
        csrfToken,
        callbackUrl: "http://localhost:3000/",
      }),
    }),
  );
  return { res, cookies: cookiesFrom(res) };
}

beforeAll(async () => {
  const { workspace, user } = await createTestWorkspace("AuthTest");
  await rawDb.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  });
  await scopedDb({ workspaceId: workspace.id }).membership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "CSM" },
  });
  email = user.email;
  userId = user.id;
  workspaceId = workspace.id;
});

describe("credentials sign-in with database sessions (D-07)", () => {
  it("creates a Session row whose token is the session cookie value", async () => {
    const before = await rawDb.session.count({ where: { userId } });
    const { cookies } = await signInWith(PASSWORD);
    const token = cookies.get("authjs.session-token");
    expect(token).toBeTruthy();
    // An opaque random token, not a JWT/JWE (those have dot-separated segments).
    expect(token!.split(".")).toHaveLength(1);
    const row = await rawDb.session.findUnique({ where: { sessionToken: token! } });
    expect(row?.userId).toBe(userId);
    expect(await rawDb.session.count({ where: { userId } })).toBe(before + 1);
  });

  it("resolves the user's workspace from the database session", async () => {
    const { cookies } = await signInWith(PASSWORD);
    const session = await findSessionByToken(cookies.get("authjs.session-token")!);
    const ctx = await resolveWorkspaceContext(session!);
    expect(ctx).toMatchObject({ userId, workspaceId, role: "CSM", canViewRevenue: false });
  });

  it("signs the user out when the Session row is deleted", async () => {
    const { cookies } = await signInWith(PASSWORD);
    const token = cookies.get("authjs.session-token")!;
    await rawDb.session.delete({ where: { sessionToken: token } });
    expect(await findSessionByToken(token)).toBeNull();
    const res = await handlers.GET(
      new NextRequest(`${BASE}/session`, { headers: { cookie: `authjs.session-token=${token}` } }),
    );
    expect(await res.json()).toBeNull();
  });

  it("a wrong password creates no Session row and writes auth.failed without the password", async () => {
    const before = await rawDb.session.count({ where: { userId } });
    const wrong = "wrong password entirely";
    const { res, cookies } = await signInWith(wrong);
    expect(cookies.get("authjs.session-token") ?? "").toBe("");
    expect(res.headers.get("location") ?? "").toMatch(/error=CredentialsSignin/);
    expect(await rawDb.session.count({ where: { userId } })).toBe(before);

    const failed = await scopedDb({ workspaceId }).auditLog.findMany({
      where: { action: "auth.failed", targetId: userId },
    });
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain(wrong);
  });

  it("successful sign-in and sign-out are audited in the user's workspace", async () => {
    const { cookies } = await signInWith(PASSWORD);
    const token = cookies.get("authjs.session-token")!;
    const csrfRes = await handlers.GET(new NextRequest(`${BASE}/csrf`));
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const csrfCookie = [...cookiesFrom(csrfRes)].map(([k, v]) => `${k}=${v}`).join("; ");
    await handlers.POST(
      new NextRequest(`${BASE}/signout`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${csrfCookie}; authjs.session-token=${token}`,
        },
        body: new URLSearchParams({ csrfToken }),
      }),
    );
    expect(await rawDb.session.findUnique({ where: { sessionToken: token } })).toBeNull();
    const actions = (
      await scopedDb({ workspaceId }).auditLog.findMany({ where: { actorId: userId } })
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.signed_in", "auth.signed_out"]));
  });

  it("the session endpoint reads the session from the database", async () => {
    const { cookies } = await signInWith(PASSWORD);
    const res = await handlers.GET(
      new NextRequest(`${BASE}/session`, {
        headers: { cookie: `authjs.session-token=${cookies.get("authjs.session-token")}` },
      }),
    );
    const body = (await res.json()) as { user?: { id?: string; email?: string } };
    expect(body.user).toMatchObject({ id: userId, email });
  });
});
