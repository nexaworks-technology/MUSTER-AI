import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import { googleCalendarAdapter } from "..";

const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_gcal",
    integrationId: "int_gcal",
    credentials: {
      accessToken: "fixture-gcal-token",
      refreshToken: "fixture-gcal-refresh",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("google-calendar", "events"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of googleCalendarAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Google Calendar contract", () => {
  it("builds OAuth authorize URL with calendar scopes", () => {
    const auth = googleCalendarAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Google Calendar uses OAuth2");
    const url = auth.authorizeUrl({
      redirectUri: "https://app.test/api/integrations/google_calendar/callback",
      state: "signed-state-gcal",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toContain("calendar.events.readonly");
    expect(parsed.searchParams.get("state")).toBe("signed-state-gcal");
  });

  it("tests connection successfully", async () => {
    const t = world();
    const res = await googleCalendarAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Google Calendar");
    expect(res.externalAccountId).toBe("csm@larkspur.test");
  });

  it("syncs events into NormalizedMeeting batch", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.kind).toBe("meetings");
    const records = batches[0]!.records as Array<{ externalId: string; title: string; attendees: Array<{ email: string }> }>;
    expect(records).toHaveLength(2);
    expect(records[0]!.externalId).toBe("gcal-evt-1");
    expect(records[0]!.title).toBe("Brightwell Logistics sync");
    expect(records[0]!.attendees).toEqual([
      { email: "leo@larkspur.test", name: "Leo Marsh", responseStatus: "ACCEPTED" },
      { email: "ben.okafor@brightwell.test", name: "Ben Okafor", responseStatus: "ACCEPTED" },
    ]);
  });
});
