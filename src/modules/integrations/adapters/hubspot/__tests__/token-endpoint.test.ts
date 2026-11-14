import { describe, expect, it } from "vitest";
import { createFixtureTransport, type FixtureInteraction } from "../../../fixture-transport";
import { hubspotAdapter } from "..";

/**
 * HubSpot retires /oauth/v1/token on 2027-02-16; its migration guide names /oauth/2026-03/token as
 * the replacement for both token requests, form-encoded, every parameter in the body (never the
 * query string). The code exchange and the refresh share one request builder, so both are pinned.
 */
const TOKEN_PATH = "/oauth/2026-03/token";
const reply = (body: Record<string, unknown>): FixtureInteraction["response"] => ({
  status: 200,
  headers: {},
  body: { token_type: "bearer", expires_in: 1800, ...body },
});
const world = () =>
  createFixtureTransport([
    {
      request: { method: "POST", path: TOKEN_PATH, bodyIncludes: "grant_type=authorization_code" },
      response: reply({ access_token: "a1", refresh_token: "r1" }),
    },
    {
      request: { method: "POST", path: TOKEN_PATH, bodyIncludes: "grant_type=refresh_token" },
      response: reply({ access_token: "a2", refresh_token: "r2" }),
    },
  ]);

function auth() {
  if (hubspotAdapter.auth.kind !== "oauth2") throw new Error("HubSpot signs in");
  return hubspotAdapter.auth;
}

describe("HubSpot token endpoint", () => {
  it("posts the code exchange to /oauth/2026-03/token, form-encoded, parameters in the body", async () => {
    const t = world();
    await auth().exchange("code-1", "https://app.test/api/integrations/hubspot/callback", t);
    expect(t.unmatched).toEqual([]);
    const [call] = t.calls;
    const url = new URL(call!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.hubapi.com${TOKEN_PATH}`);
    expect(url.search).toBe("");
    expect(call!.method).toBe("POST");
    expect(call!.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call!.body);
    expect([...form.keys()].sort()).toEqual(
      ["client_id", "client_secret", "code", "grant_type", "redirect_uri"].sort(),
    );
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("redirect_uri")).toBe("https://app.test/api/integrations/hubspot/callback");
  });

  it("posts the refresh to the same endpoint with the refresh-token fields", async () => {
    const t = world();
    const refreshed = await auth().refresh({ accessToken: "old", refreshToken: "r-old" }, t);
    expect(t.unmatched).toEqual([]);
    const [call] = t.calls;
    const url = new URL(call!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.hubapi.com${TOKEN_PATH}`);
    expect(url.search).toBe("");
    expect(call!.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call!.body);
    expect([...form.keys()].sort()).toEqual(
      ["client_id", "client_secret", "grant_type", "refresh_token"].sort(),
    );
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("r-old");
    expect(refreshed).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
  });

  it("never calls the retired v1 path", async () => {
    const t = world();
    await auth().exchange("c", "https://app.test/cb", t);
    await auth().refresh({ refreshToken: "r" }, t);
    expect(t.calls.every((c) => !c.url.includes("/oauth/v1/"))).toBe(true);
  });
});
