import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { freshdeskAdapter } from "../adapters/freshdesk";
import { zendeskAdapter } from "../adapters/zendesk";
import {
  API_KEY_FORM_PROVIDERS,
  connectWithApiKey,
  ConnectError,
  replaceApiKey,
  testConnection,
} from "../connections.service";
import { runSync } from "../sync.jobs";
import { openCredentials, sealCredentials } from "../credentials";
import { ConnectionSettingMissingError } from "../errors";
import { createFixtureTransport, type FixtureInteraction } from "../fixture-transport";

/**
 * CONNECTOR-LIVE.md, Zendesk and Freshdesk blocker 1: the connect form must collect the Zendesk
 * subdomain + admin email and the Freshdesk domain, they must be stored and reach the adapter, and
 * a missing value is an honest error before any request: never a call to app.zendesk.com or
 * app.freshdesk.com with an empty email.
 */
const ZD_ME: FixtureInteraction = {
  request: { method: "GET", path: "/api/v2/users/me.json" },
  response: { status: 200, headers: {}, body: { user: { id: 7, email: "admin@acme.test" } } },
};
const FD_TICKETS: FixtureInteraction = {
  request: { method: "GET", path: "/api/v2/tickets" },
  response: { status: 200, headers: {}, body: [] },
};

function deps(interactions: FixtureInteraction[]) {
  const transport = createFixtureTransport(interactions);
  return { transport, deps: { transport: () => transport } };
}

async function storedCredentials(workspaceId: string, provider: "ZENDESK" | "FRESHDESK") {
  const row = await scopedDb({ workspaceId }).integration.findFirstOrThrow({
    where: { provider },
    select: { credentialsEnc: true, status: true },
  });
  return { ...openCredentials(row.credentialsEnc), status: row.status };
}

describe("Settings form providers", () => {
  it("offers the key form for Zendesk and Freshdesk", () => {
    expect(API_KEY_FORM_PROVIDERS).toEqual(
      expect.arrayContaining(["STRIPE", "CHARGEBEE", "ZENDESK", "FRESHDESK"]),
    );
  });
});

describe("Zendesk connect settings", () => {
  it("refuses a missing subdomain before any request", async () => {
    const { actor } = await createTestAdmin("zd-no-site");
    const { transport, deps: d } = deps([ZD_ME]);
    await expect(
      connectWithApiKey(actor, "ZENDESK", { apiKey: "zd-token-12345", username: "a@acme.test" }, d),
    ).rejects.toThrow(/subdomain/i);
    expect(transport.calls).toEqual([]);
  });

  it("refuses a missing or malformed admin email before any request", async () => {
    const { actor } = await createTestAdmin("zd-no-email");
    const { transport, deps: d } = deps([ZD_ME]);
    await expect(
      connectWithApiKey(actor, "ZENDESK", { apiKey: "zd-token-12345", site: "acme" }, d),
    ).rejects.toThrow(/admin email/i);
    await expect(
      connectWithApiKey(
        actor,
        "ZENDESK",
        { apiKey: "zd-token-12345", site: "acme", username: "not-an-email" },
        d,
      ),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(transport.calls).toEqual([]);
  });

  it("accepts a pasted Zendesk address, validates against that subdomain and stores both", async () => {
    const { actor } = await createTestAdmin("zd-ok");
    const { transport, deps: d } = deps([ZD_ME]);
    await connectWithApiKey(
      actor,
      "ZENDESK",
      { apiKey: "zd-token-12345", site: "https://Acme.zendesk.com/", username: "admin@acme.test" },
      d,
    );
    expect(transport.calls.length).toBeGreaterThan(0);
    for (const c of transport.calls) {
      expect(new URL(c.url).host).toBe("acme.zendesk.com");
      expect(c.headers?.authorization).toBe(
        `Basic ${Buffer.from("admin@acme.test/token:zd-token-12345").toString("base64")}`,
      );
    }
    const stored = await storedCredentials(actor.workspaceId, "ZENDESK");
    expect(stored).toMatchObject({
      site: "acme",
      username: "admin@acme.test",
      status: "CONNECTED",
    });
  });
});

describe("Freshdesk connect settings", () => {
  it("refuses a missing domain before any request", async () => {
    const { actor } = await createTestAdmin("fd-no-domain");
    const { transport, deps: d } = deps([FD_TICKETS]);
    await expect(
      connectWithApiKey(actor, "FRESHDESK", { apiKey: "fd-key-12345" }, d),
    ).rejects.toThrow(/domain/i);
    expect(transport.calls).toEqual([]);
  });

  it("validates against the entered domain and stores it", async () => {
    const { actor } = await createTestAdmin("fd-ok");
    const { transport, deps: d } = deps([FD_TICKETS]);
    await connectWithApiKey(
      actor,
      "FRESHDESK",
      { apiKey: "fd-key-12345", site: "acme-help.freshdesk.com" },
      d,
    );
    expect(transport.calls.length).toBeGreaterThan(0);
    expect(transport.calls.every((c) => new URL(c.url).host === "acme-help.freshdesk.com")).toBe(
      true,
    );
    expect(await storedCredentials(actor.workspaceId, "FRESHDESK")).toMatchObject({
      site: "acme-help",
      status: "CONNECTED",
    });
  });
});

describe("no silent fallback in the adapters", () => {
  const ctx = (credentials: Record<string, string>) => {
    const transport = createFixtureTransport([ZD_ME, FD_TICKETS]);
    return {
      transport,
      ctx: {
        workspaceId: "ws",
        integrationId: "int",
        credentials,
        config: {},
        transport,
        clock: () => new Date("2026-11-13T12:00:00Z"),
      },
    };
  };

  it("Zendesk throws a missing-setting error instead of calling app.zendesk.com", async () => {
    const a = ctx({ apiKey: "zd-token-12345" });
    await expect(zendeskAdapter.testConnection(a.ctx)).rejects.toBeInstanceOf(
      ConnectionSettingMissingError,
    );
    await expect(
      zendeskAdapter.sync(a.ctx, { kind: "FULL" })[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(ConnectionSettingMissingError);
    const b = ctx({ apiKey: "zd-token-12345", site: "acme" });
    await expect(zendeskAdapter.testConnection(b.ctx)).rejects.toThrow(/admin email/i);
    expect([...a.transport.calls, ...b.transport.calls]).toEqual([]);
    expect(
      zendeskAdapter.describeError(new ConnectionSettingMissingError("Zendesk", "subdomain")).plain,
    ).toBe("Zendesk is missing its subdomain, so nothing was requested.");
  });

  it("Freshdesk throws a missing-setting error instead of calling app.freshdesk.com", async () => {
    const a = ctx({ apiKey: "fd-key-12345" });
    await expect(freshdeskAdapter.testConnection(a.ctx)).rejects.toBeInstanceOf(
      ConnectionSettingMissingError,
    );
    await expect(
      freshdeskAdapter.sync(a.ctx, { kind: "FULL" })[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(ConnectionSettingMissingError);
    expect(a.transport.calls).toEqual([]);
  });

  it("an existing connection with no subdomain shows an honest error on the card", async () => {
    const { actor } = await createTestAdmin("zd-legacy");
    const row = await scopedDb(actor).integration.create({
      data: {
        workspaceId: actor.workspaceId,
        provider: "ZENDESK",
        credentialsEnc: sealCredentials({ apiKey: "zd-token-12345" }),
        scopes: [],
        connectedByMembershipId: actor.membershipId,
        connectedAt: new Date(),
      },
    });
    const { transport, deps: d } = deps([ZD_ME]);
    const r = await testConnection(actor, row.id, d);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Zendesk is missing its subdomain, so nothing was requested\./);
    expect(transport.calls).toEqual([]);
    const after = await scopedDb(actor).integration.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("ERROR");
    expect(after.lastErrorPlain).toMatch(/missing its subdomain/);
  });
});

/**
 * Zendesk OAuth (B7): the client ID and secret connect an account that cannot have an API token. The
 * secret is sealed with the other credentials; a refused client saves nothing and the card shows
 * "Needs attention" with the likely cause, keeping the last good sync.
 */
const OAUTH_OK: FixtureInteraction = {
  request: { method: "POST", path: "/oauth/tokens", bodyIncludes: "grant_type=client_credentials" },
  response: {
    status: 201,
    headers: {},
    body: {
      access_token: "int-oauth-token",
      token_type: "bearer",
      scope: "read",
      expires_in: 1800,
    },
  },
};
const OAUTH_REFUSED: FixtureInteraction = {
  request: { method: "POST", path: "/oauth/tokens" },
  response: { status: 400, headers: {}, body: { error: "invalid_client" } },
};
const ZD_EXPORT_EMPTY: FixtureInteraction = {
  request: { method: "GET", path: "/api/v2/incremental/tickets.json" },
  response: {
    status: 200,
    headers: {},
    body: { tickets: [], users: [], count: 0, end_of_stream: true, end_time: null },
  },
};

describe("Zendesk OAuth connect", () => {
  it("connects with a subdomain, client ID and secret: no admin email, sealed, Bearer on the reads", async () => {
    const { actor } = await createTestAdmin("zd-oauth-ok");
    const { transport, deps: d } = deps([OAUTH_OK, ZD_ME]);
    await connectWithApiKey(
      actor,
      "ZENDESK",
      {
        site: "https://Acme.zendesk.com/",
        clientId: "zd-cid",
        clientSecret: "zd-client-secret-123",
      },
      d,
    );
    const api = transport.calls.filter((c) => !c.url.endsWith("/oauth/tokens"));
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) expect(c.headers?.authorization).toBe("Bearer int-oauth-token");
    const stored = await storedCredentials(actor.workspaceId, "ZENDESK");
    expect(stored).toMatchObject({
      site: "acme",
      clientId: "zd-cid",
      clientSecret: "zd-client-secret-123",
      status: "CONNECTED",
    });
    expect(stored.username).toBeUndefined();
    expect(stored.apiKey).toBeUndefined();
    // The raw column never holds the secret in the clear.
    const raw = await scopedDb(actor).integration.findFirstOrThrow({
      where: { provider: "ZENDESK" },
      select: { credentialsEnc: true },
    });
    expect(raw.credentialsEnc).not.toContain("zd-client-secret-123");
  });

  it("refuses a missing subdomain or half-filled client before any request", async () => {
    const { actor } = await createTestAdmin("zd-oauth-missing");
    const { transport, deps: d } = deps([OAUTH_OK, ZD_ME]);
    await expect(
      connectWithApiKey(
        actor,
        "ZENDESK",
        { clientId: "zd-cid", clientSecret: "zd-client-secret-123" },
        d,
      ),
    ).rejects.toThrow(/subdomain/i);
    await expect(
      connectWithApiKey(actor, "ZENDESK", { site: "acme", clientId: "zd-cid" }, d),
    ).rejects.toThrow();
    expect(transport.calls).toEqual([]);
  });

  it("a refused client saves nothing and names the likely cause", async () => {
    const { actor } = await createTestAdmin("zd-oauth-refused");
    const { deps: d } = deps([OAUTH_REFUSED]);
    const err = await connectWithApiKey(
      actor,
      "ZENDESK",
      { site: "acme", clientId: "zd-cid", clientSecret: "wrong-secret-123" },
      d,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as Error).message).toMatch(/revoked|deleted/i);
    expect((err as Error).message).not.toContain("wrong-secret-123");
    const rows = await scopedDb(actor).integration.findMany({ where: { provider: "ZENDESK" } });
    expect(rows).toEqual([]);
  });

  it("a revoked client turns the card to Needs attention, keeps the last good sync, and Replace swaps the client", async () => {
    const { actor } = await createTestAdmin("zd-oauth-revoked");
    const ok = deps([OAUTH_OK, ZD_ME, ZD_EXPORT_EMPTY]);
    const { integrationId } = await connectWithApiKey(
      actor,
      "ZENDESK",
      { site: "acme", clientId: "zd-cid", clientSecret: "zd-client-secret-123" },
      ok.deps,
    );
    const payload = (runKey: string) => ({
      workspaceId: actor.workspaceId,
      integrationId,
      kind: "INCREMENTAL" as const,
      trigger: "MANUAL" as const,
      runKey,
    });
    const good = await runSync(payload("good"), ok.deps);
    expect(good.status).toBe("SUCCEEDED");
    const lastSync = (
      await scopedDb(actor).integration.findUniqueOrThrow({ where: { id: integrationId } })
    ).lastSyncAt;
    expect(lastSync).not.toBeNull();

    // The founder deletes the OAuth client in Zendesk: the token endpoint refuses it.
    const revoked = deps([OAUTH_REFUSED]);
    const bad = await runSync(payload("bad"), revoked.deps);
    expect(bad.status).toBe("FAILED");
    expect(bad.errorPlain).toMatch(/OAuth client/);
    const failed = await scopedDb(actor).integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    expect(failed.status).toBe("ERROR"); // "Needs attention"
    expect(failed.lastErrorPlain).toMatch(/revoked|deleted/i);
    expect(failed.lastSyncAt?.getTime()).toBe(lastSync?.getTime()); // last good sync kept
    const check = await testConnection(actor, integrationId, revoked.deps);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/OAuth client/);

    // A refused replacement changes nothing; an accepted one swaps the client in place.
    await expect(
      replaceApiKey(
        actor,
        integrationId,
        { clientId: "zd-cid-2", clientSecret: "still-wrong-secret" },
        revoked.deps,
      ),
    ).rejects.toThrow(/saved client was kept/i);
    expect((await storedCredentials(actor.workspaceId, "ZENDESK")).clientId).toBe("zd-cid");
    const fresh = deps([OAUTH_OK, ZD_ME, ZD_EXPORT_EMPTY]);
    await replaceApiKey(
      actor,
      integrationId,
      { clientId: "zd-cid-2", clientSecret: "fresh-client-secret" },
      fresh.deps,
    );
    expect(await storedCredentials(actor.workspaceId, "ZENDESK")).toMatchObject({
      clientId: "zd-cid-2",
      clientSecret: "fresh-client-secret",
      site: "acme",
      status: "CONNECTED",
    });
    const clean = await runSync(payload("clean"), fresh.deps);
    expect(clean.status).toBe("SUCCEEDED");
  });

  it("the legacy email + API token path keeps working for accounts that still have a token", async () => {
    const { actor } = await createTestAdmin("zd-legacy-still");
    const { transport, deps: d } = deps([ZD_ME]);
    await connectWithApiKey(
      actor,
      "ZENDESK",
      { apiKey: "zd-token-12345", site: "acme", username: "admin@acme.test" },
      d,
    );
    expect(transport.calls.some((c) => c.url.endsWith("/oauth/tokens"))).toBe(false);
  });
});
