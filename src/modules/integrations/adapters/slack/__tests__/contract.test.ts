import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import type { ProviderHttpError } from "../../../transport";
import { slackAdapter, slackApi, usersPage, verifySlackSignature } from "..";

/** Slack contract: request signing, OAuth, ok:false errors in plain words, users paging. */
const NOW = new Date("2026-11-02T15:00:00Z");
const SECRET = "slack-signing-secret-test-only";
const ts = String(Math.floor(NOW.getTime() / 1000));
const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
const sign = (secret: string, t = ts, b = body) =>
  `v0=${createHmac("sha256", secret).update(`v0:${t}:${b}`).digest("hex")}`;

describe("Slack request signature (M5 §2: signing secret + 5-minute window)", () => {
  it("accepts Slack's v0 scheme", () => {
    expect(verifySlackSignature(body, ts, sign(SECRET), SECRET, NOW)).toBe(true);
  });
  it.each([
    ["a forged signature", ts, () => sign("attacker-secret")],
    ["a body changed after signing", ts, () => sign(SECRET, ts, "payload=other")],
    [
      "a timestamp 6 minutes old",
      String(Number(ts) - 360),
      () => sign(SECRET, String(Number(ts) - 360)),
    ],
    [
      "a timestamp 6 minutes ahead",
      String(Number(ts) + 360),
      () => sign(SECRET, String(Number(ts) + 360)),
    ],
    ["a non-numeric timestamp", "soon", () => sign(SECRET, "soon")],
  ])("refuses %s", (_l, t, sig) => {
    expect(verifySlackSignature(body, t, sig(), SECRET, NOW)).toBe(false);
  });
  it("refuses missing headers", () => {
    expect(verifySlackSignature(body, undefined, sign(SECRET), SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(body, ts, undefined, SECRET, NOW)).toBe(false);
  });
});

describe("Slack contract", () => {
  const world = () => createFixtureTransport(loadFixture("slack", "auth"));

  it("exchanges the code for a bot token; the consent URL asks for the bot scopes", async () => {
    const auth = slackAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Slack signs in");
    const url = new URL(auth.authorizeUrl({ redirectUri: "https://app.test/cb", state: "s.t" }));
    expect(url.searchParams.get("scope")).toBe("chat:write,im:write,users:read,users:read.email");
    expect(await auth.exchange("c", "https://app.test/cb", world())).toEqual({
      accessToken: "fixture-slack-bot-token-not-a-secret",
    });
  });

  it("testConnection names the team", async () => {
    const r = await slackAdapter.testConnection({
      workspaceId: "w",
      integrationId: "i",
      credentials: { accessToken: "fixture-slack-bot-token-not-a-secret" },
      config: {},
      transport: world(),
      clock: () => NOW,
    });
    expect(r).toMatchObject({ ok: true, externalAccountId: "TLARKSPUR1" });
  });

  it("pages users.list by cursor", async () => {
    const t = createFixtureTransport(loadFixture("slack", "users"));
    const first = await slackApi(t, "fixture-slack-token", "users.list", { limit: 200 }, usersPage);
    const second = await slackApi(
      t,
      "fixture-slack-token",
      "users.list",
      { limit: 200, cursor: first.response_metadata!.next_cursor },
      usersPage,
    );
    expect([...first.members, ...second.members].map((m) => m.id)).toEqual([
      "U0AISHA",
      "U0PRIYA",
      "U0BOT",
      "USLACKBOT",
      "U0LEO",
      "U0GUEST",
    ]);
  });

  it.each([
    ["error-invalid-auth", "auth.test", 401, "Slack rejected the saved credentials."],
    [
      "error-missing-scope",
      "users.list",
      403,
      "Slack refused access: the connection is missing a permission it needs.",
    ],
    [
      "error-ratelimited",
      "users.list",
      429,
      "Slack asked us to slow down (rate limit); it will accept requests again in about 3 seconds.",
    ],
  ])("%s (Slack's ok:false) → HTTP %s in plain words", async (fixture, method, status, plain) => {
    const t = createFixtureTransport(loadFixture("slack", fixture));
    const err = await slackApi(
      t,
      "fixture-slack-token",
      method,
      {},
      z.object({ ok: z.literal(true) }),
    ).catch((e: unknown) => e);
    expect((err as ProviderHttpError).status).toBe(status);
    expect(slackAdapter.describeError(err).plain).toBe(plain);
  });
});
