import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedMail } from "../../../normalized";
import { ProviderHttpError } from "../../../transport";
import { microsoftEmailAdapter } from "..";

/**
 * Microsoft Graph email contract: recorded payloads labelled "authored from docs, not captured".
 * Tests OAuth, delta polling sync, mailbox draft write-back, and plain-words errors.
 */
const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_graph",
    integrationId: "int_graph",
    credentials: {
      accessToken: "fixture-graph-access-token",
      refreshToken: "fixture-graph-refresh-token",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("microsoft-email", "messages"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of microsoftEmailAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Microsoft Graph (microsoft-email) contract", () => {
  it("builds OAuth authorize URL with prompt and required scopes", () => {
    const auth = microsoftEmailAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Outlook uses OAuth2");
    const url = auth.authorizeUrl({
      redirectUri: "https://app.test/api/integrations/microsoft_email/callback",
      state: "signed-state-token",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://login.microsoftonline.com");
    expect(parsed.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toContain("Mail.Read");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
  });

  it("exchanges code for tokens and refreshes expired token", async () => {
    const auth = microsoftEmailAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Outlook uses OAuth2");
    const t = world();
    const creds = await auth.exchange(
      "fixture-code",
      "https://app.test/api/integrations/microsoft_email/callback",
      t,
    );
    expect(creds.accessToken).toBe("graph-token-123");
    expect(creds.refreshToken).toBe("graph-refresh-123");

    const refreshed = await auth.refresh(
      { accessToken: "old", refreshToken: "graph-refresh-123" },
      t,
    );
    expect(refreshed.accessToken).toBe("graph-token-refreshed");
  });

  it("validates connection via Graph /me endpoint", async () => {
    const t = world();
    const res = await microsoftEmailAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("csm@company.test");
    expect(res.externalAccountId).toBe("csm@company.test");
  });

  it("syncs messages with delta token and maps to NormalizedMail", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches.length).toBeGreaterThan(0);
    const mailBatch = batches.find((b) => b.kind === "mail");
    expect(mailBatch).toBeDefined();

    const records = (mailBatch?.records ?? []) as NormalizedMail[];
    expect(records.length).toBe(2);

    const first = records[0]!;
    expect(first.externalId).toBe("graph_msg_001");
    expect(first.threadExternalId).toBe("graph_conv_001");
    expect(first.direction).toBe("INBOUND");
    expect(first.fromAddress).toBe("david@enterprise.test");
    expect(first.toAddresses).toEqual(["csm@company.test"]);
    expect(first.subject).toBe("Security Assessment & SSO Setup");
    expect(first.bodyText).toContain("We need our SAML metadata verified");

    const cursorBatch = batches.find((b) => b.cursor);
    expect(cursorBatch?.cursor).toBe("delta-token-xyz");
  });

  it("writeBack declares draft field and pushes draft into mailbox", async () => {
    expect(microsoftEmailAdapter.writeBack?.fields).toEqual([
      { key: "draft", label: "Draft in mailbox" },
    ]);

    const t = world();
    const res = await microsoftEmailAdapter.writeBack!.push(ctx(t), {
      field: "draft",
      accountId: "acc_1",
      externalId: "graph_conv_001",
      value: "Hi David, our SAML documentation is attached.",
    });

    expect(res).toEqual({ externalId: "draft_graph_888" });
    const call = t.calls.find((c) => c.url.includes("/messages") && c.method === "POST");
    expect(call).toBeDefined();
  });

  it("describes provider errors in plain words", () => {
    const err401 = new ProviderHttpError(401);
    const desc401 = microsoftEmailAdapter.describeError(err401);
    expect(desc401.plain).toContain("Outlook rejected the saved credentials");
    expect(desc401.action).toContain("Reconnect Outlook from Settings › Integrations");
  });
});
