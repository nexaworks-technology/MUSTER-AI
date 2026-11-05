import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedTranscript } from "../../../normalized";
import { zoomAdapter } from "..";

const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_zoom",
    integrationId: "int_zoom",
    credentials: {
      accessToken: "fixture-zoom-token",
      refreshToken: "fixture-zoom-refresh",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("zoom", "recordings"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of zoomAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Zoom contract", () => {
  it("builds OAuth authorize URL with recording scopes", () => {
    const auth = zoomAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Zoom uses OAuth2");
    const url = auth.authorizeUrl({
      redirectUri: "https://app.test/api/integrations/zoom/callback",
      state: "signed-state-zoom",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://zoom.us");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toContain("cloud_recording:read");
    expect(parsed.searchParams.get("state")).toBe("signed-state-zoom");
  });

  it("tests connection successfully", async () => {
    const t = world();
    const res = await zoomAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Zoom (Leo Marsh)");
    expect(res.externalAccountId).toBe("zoom-user-1");
  });

  it("syncs recordings and transcripts into NormalizedTranscript batch", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.kind).toBe("transcripts");
    const records = batches[0]!.records as NormalizedTranscript[];
    expect(records).toHaveLength(1);
    expect(records[0]!.externalId).toBe("zoom-rec-1");
    expect(records[0]!.title).toBe("Brightwell Quarterly Sync");
    expect(records[0]!.attendeeEmails).toEqual(["leo@larkspur.test", "ben.okafor@brightwell.test"]);
    expect(records[0]!.text).toContain("Leo Marsh: Welcome to our sync.");
    expect(records[0]!.text).toContain("Ben Okafor: Thank you, let us discuss milestones.");
  });
});
