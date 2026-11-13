import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { freshdeskAdapter } from "../adapters/freshdesk";
import { zendeskAdapter } from "../adapters/zendesk";
import {
  API_KEY_FORM_PROVIDERS,
  connectWithApiKey,
  ConnectError,
  testConnection,
} from "../connections.service";
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
