import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { IntegrationAdapter } from "../adapter";
import { loadConnection } from "../connection";
import {
  completeOAuth,
  connectWithApiKey,
  ConnectError,
  disconnect,
  startOAuth,
} from "../connections.service";
import { openCredentials } from "../credentials";
import { describeProviderError } from "../errors";
import { createFixtureTransport } from "../fixture-transport";
import { OAuthStateError, signState, verifyState } from "../oauth";
import { ProviderHttpError } from "../transport";

/**
 * M5 §5 oauth.test: a tampered state is refused before any exchange; tokens are stored sealed
 * (raw DB value ≠ token); refresh re-seals; disconnect wipes; Admin only (M5 rule 3).
 */
const ACCESS = "fake-access-token-AAA";
const REFRESH = "fake-refresh-token-BBB";
const NEW_ACCESS = "fake-access-token-CCC";
const NOW = new Date("2026-11-02T12:00:00Z");
const clock = () => NOW;

function oauthAdapter() {
  const exchange = vi.fn(async () => ({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  }));
  const refresh = vi.fn(async () => ({
    accessToken: NEW_ACCESS,
    expiresAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
  }));
  const adapter: IntegrationAdapter<Record<string, never>> = {
    provider: "HUBSPOT",
    category: "CRM",
    displayName: "Fake OAuth CRM",
    configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    auth: {
      kind: "oauth2",
      scopes: ["crm.objects.companies.read"],
      authorizeUrl: ({ redirectUri, state }) =>
        `https://auth.fake.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
      exchange,
      refresh,
    },
    testConnection: async () => ({
      ok: true,
      message: "Connected.",
      externalAccountId: "portal-1",
    }),
    async *sync() {},
    describeError: (e) => describeProviderError(e, "Fake", "Reconnect Fake."),
  };
  const deps = {
    clock,
    adapter: () => adapter as IntegrationAdapter<unknown>,
    transport: () => createFixtureTransport([]),
  };
  return { adapter, exchange, refresh, deps };
}

async function rawCredentials(workspaceId: string) {
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.integration.findMany({ select: { credentialsEnc: true } });
  });
}

describe("OAuth state (CSRF)", () => {
  const s = {
    workspaceId: "ws1",
    membershipId: "m1",
    provider: "HUBSPOT" as const,
    nonce: "nonce-0123456789abcdef",
  };
  const secret = "s".repeat(40);
  const good = () => signState(s, clock, secret);

  it("accepts the state it signed for the same member, provider and browser nonce", () => {
    expect(() => verifyState(good(), s, clock, secret)).not.toThrow();
  });

  it.each([
    [
      "a changed payload",
      () => `${Buffer.from('{"w":"ws2"}').toString("base64url")}.${good().split(".")[1]}`,
      s,
      "bad signature",
    ],
    ["a forged signature", () => `${good().split(".")[0]}.AAAA`, s, "bad signature"],
    ["junk", () => "not-a-state", s, "malformed"],
    ["another workspace", good, { ...s, workspaceId: "ws2" }, "started by someone else"],
    ["another member", good, { ...s, membershipId: "m2" }, "started by someone else"],
    ["another provider", good, { ...s, provider: "SALESFORCE" as const }, "wrong provider"],
    ["no nonce cookie", good, { ...s, nonce: undefined }, "not started in this browser"],
    [
      "another browser's nonce",
      good,
      { ...s, nonce: "nonce-ffffffffffffffff" },
      "not started in this browser",
    ],
  ])("refuses %s", (_label, make, expected, reason) => {
    expect(() => verifyState(make(), expected, clock, secret)).toThrow(new OAuthStateError(reason));
  });

  it("refuses an expired state", () => {
    const later = () => new Date(NOW.getTime() + 11 * 60_000);
    expect(() => verifyState(good(), s, later, secret)).toThrow(/expired/);
  });
});

describe("OAuth connect, token storage and refresh", () => {
  it("a tampered state exchanges nothing and stores nothing", async () => {
    const { actor } = await createTestAdmin("OAuthTamper");
    const f = oauthAdapter();
    const { state, nonce } = startOAuth(actor, "HUBSPOT", f.deps);
    const tampered = `${state.split(".")[0]}x.${state.split(".")[1]}`;
    await expect(
      completeOAuth(actor, "HUBSPOT", { code: "c", state: tampered, nonce }, f.deps),
    ).rejects.toBeInstanceOf(OAuthStateError);
    expect(f.exchange).not.toHaveBeenCalled();
    expect(await scopedDb(actor).integration.count()).toBe(0);
  });

  it("stores tokens sealed: the raw column never contains them, and the audit row neither", async () => {
    const { actor } = await createTestAdmin("OAuthSealed");
    const f = oauthAdapter();
    const { url, state, nonce } = startOAuth(actor, "HUBSPOT", f.deps);
    expect(decodeURIComponent(url)).toContain("/api/integrations/hubspot/callback");
    const { integrationId, check } = await completeOAuth(
      actor,
      "HUBSPOT",
      { code: "code-123", state, nonce },
      f.deps,
    );
    expect(check).toEqual({ ok: true, message: "Connected." });
    const [row] = await rawCredentials(actor.workspaceId);
    expect(row?.credentialsEnc).toBeTruthy();
    expect(row?.credentialsEnc).not.toContain(ACCESS);
    expect(row?.credentialsEnc).not.toContain(REFRESH);
    expect(openCredentials(row!.credentialsEnc)).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    const integ = await scopedDb(actor).integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    expect(integ).toMatchObject({
      status: "CONNECTED",
      writeBackEnabled: false,
      externalAccountId: "portal-1",
      scopes: ["crm.objects.companies.read"],
    });
    const audits = await scopedDb(actor).auditLog.findMany({ where: { targetId: integrationId } });
    expect(audits.map((a) => a.action)).toEqual(["integration.connected"]);
    expect(JSON.stringify(audits)).not.toContain(ACCESS);
  });

  it("an expired access token is refreshed before use and stored sealed again", async () => {
    const { actor } = await createTestAdmin("OAuthRefresh");
    const f = oauthAdapter();
    const { state, nonce } = startOAuth(actor, "HUBSPOT", f.deps);
    const { integrationId } = await completeOAuth(
      actor,
      "HUBSPOT",
      { code: "c", state, nonce },
      f.deps,
    );
    const [before] = await rawCredentials(actor.workspaceId);
    const twoHoursLater = () => new Date(NOW.getTime() + 2 * 3_600_000);
    const { context } = await loadConnection(actor, integrationId, {
      ...f.deps,
      clock: twoHoursLater,
    });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(context.credentials.accessToken).toBe(NEW_ACCESS);
    const [after] = await rawCredentials(actor.workspaceId);
    expect(after?.credentialsEnc).not.toBe(before?.credentialsEnc);
    expect(after?.credentialsEnc).not.toContain(NEW_ACCESS);
    expect(openCredentials(after!.credentialsEnc)).toMatchObject({
      accessToken: NEW_ACCESS,
      refreshToken: REFRESH, // kept when the provider does not rotate it
    });
    // A token that is still fresh is not refreshed again.
    await loadConnection(actor, integrationId, f.deps);
    expect(f.refresh).toHaveBeenCalledOnce();
  });

  it("disconnect deletes the credentials and turns write-back off; history stays", async () => {
    const { actor } = await createTestAdmin("OAuthDisconnect");
    const f = oauthAdapter();
    const { state, nonce } = startOAuth(actor, "HUBSPOT", f.deps);
    const { integrationId } = await completeOAuth(
      actor,
      "HUBSPOT",
      { code: "c", state, nonce },
      f.deps,
    );
    await disconnect(actor, integrationId);
    const row = await scopedDb(actor).integration.findUniqueOrThrow({
      where: { id: integrationId },
    });
    expect(row).toMatchObject({
      status: "DISCONNECTED",
      credentialsEnc: null,
      writeBackEnabled: false,
    });
    await expect(loadConnection(actor, integrationId, f.deps)).rejects.toThrow(/disconnected/);
  });

  it("only an Admin can connect", async () => {
    const { actor } = await createTestAdmin("OAuthRole");
    const f = oauthAdapter();
    expect(() => startOAuth({ ...actor, role: "CSM" }, "HUBSPOT", f.deps)).toThrow(ForbiddenError);
    expect(() => startOAuth({ ...actor, role: "CS_LEADER" }, "HUBSPOT", f.deps)).toThrow(
      ForbiddenError,
    );
  });
});

describe("API-key connect", () => {
  it("a rejected key is refused in plain words, audited without the key, and nothing is stored", async () => {
    const { actor } = await createTestAdmin("ApiKeyRejected");
    const adapter: IntegrationAdapter<Record<string, never>> = {
      provider: "STRIPE",
      category: "BILLING",
      displayName: "Fake billing",
      configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
      auth: {
        kind: "apiKey",
        validate: async () => {
          throw new ProviderHttpError(401);
        },
      },
      testConnection: async () => ({ ok: true, message: "ok" }),
      async *sync() {},
      describeError: (e) => describeProviderError(e, "Stripe", "Paste a restricted read-only key."),
    };
    const deps = {
      adapter: () => adapter as IntegrationAdapter<unknown>,
      transport: () => createFixtureTransport([]),
    };
    await expect(
      connectWithApiKey(actor, "STRIPE", { apiKey: "rk_test_wrong_key_123" }, deps),
    ).rejects.toThrow(
      new ConnectError("Stripe rejected the saved credentials. Paste a restricted read-only key."),
    );
    expect(await scopedDb(actor).integration.count()).toBe(0);
    const audit = await scopedDb(actor).auditLog.findFirstOrThrow({
      where: { action: "integration.connect_failed" },
    });
    expect(JSON.stringify(audit)).not.toContain("rk_test_wrong_key_123");
  });
});
