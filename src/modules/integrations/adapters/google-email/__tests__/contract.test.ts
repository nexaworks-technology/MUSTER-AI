import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedMail } from "../../../normalized";
import { ProviderHttpError } from "../../../transport";
import { googleEmailAdapter } from "..";

/**
 * Gmail contract: recorded payloads labelled "authored from docs, not captured".
 * Tests OAuth, message sync, mailbox draft write-back, and plain-words errors.
 */
const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_gmail",
    integrationId: "int_gmail",
    credentials: {
      accessToken: "fixture-gmail-access-token",
      refreshToken: "fixture-gmail-refresh-token",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("google-email", "messages"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of googleEmailAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Gmail (google-email) contract", () => {
  it("builds OAuth authorize URL with prompt and required scopes", () => {
    const auth = googleEmailAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Gmail uses OAuth2");
    const url = auth.authorizeUrl({
      redirectUri: "https://app.test/api/integrations/google_email/callback",
      state: "signed-state-token",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(parsed.searchParams.get("state")).toBe("signed-state-token");
  });

  it("exchanges code for tokens and refreshes expired token", async () => {
    const auth = googleEmailAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Gmail uses OAuth2");
    const t = world();
    const creds = await auth.exchange(
      "fixture-code",
      "https://app.test/api/integrations/google_email/callback",
      t,
    );
    expect(creds.accessToken).toBe("gmail-token-123");
    expect(creds.refreshToken).toBe("gmail-refresh-123");

    const refreshed = await auth.refresh(
      { accessToken: "old", refreshToken: "gmail-refresh-123" },
      t,
    );
    expect(refreshed.accessToken).toBe("gmail-token-refreshed");
  });

  it("validates connection via Gmail profile endpoint", async () => {
    const t = world();
    const res = await googleEmailAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("csm@company.test");
    expect(res.externalAccountId).toBe("csm@company.test");
  });

  it("syncs messages and maps headers/body to NormalizedMail", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches.length).toBeGreaterThan(0);
    const mailBatch = batches.find((b) => b.kind === "mail");
    expect(mailBatch).toBeDefined();

    const records = (mailBatch?.records ?? []) as NormalizedMail[];
    expect(records.length).toBe(2);

    const first = records[0]!;
    expect(first.externalId).toBe("gmail_msg_001");
    expect(first.threadExternalId).toBe("gmail_thread_001");
    expect(first.direction).toBe("INBOUND");
    expect(first.fromAddress).toBe("sarah@customer.test");
    expect(first.toAddresses).toEqual(["csm@company.test"]);
    expect(first.subject).toBe("Q4 Expansion & Contract Renewal");
    expect(first.bodyText).toContain("We want to add 50 seats");

    const cursorBatch = batches.find((b) => b.cursor);
    expect(cursorBatch?.cursor).toBe("100200");
  });

  it("writeBack declares draft field and pushes draft into mailbox", async () => {
    expect(googleEmailAdapter.writeBack?.fields).toEqual([
      { key: "draft", label: "Draft in mailbox" },
    ]);

    const t = world();
    const res = await googleEmailAdapter.writeBack!.push(ctx(t), {
      field: "draft",
      accountId: "acc_1",
      externalId: "gmail_thread_001",
      value: "Hi Sarah, happy to assist with the 50 additional seats.",
    });

    expect(res).toEqual({ externalId: "draft_gmail_999" });
    const call = t.calls.find((c) => c.url.includes("/drafts") && c.method === "POST");
    expect(call).toBeDefined();
  });

  it("describes provider errors in plain words", () => {
    const err401 = new ProviderHttpError(401);
    const desc401 = googleEmailAdapter.describeError(err401);
    expect(desc401.plain).toContain("Gmail rejected the saved credentials");
    expect(desc401.action).toContain("Reconnect Gmail from Settings › Integrations");
  });
});
