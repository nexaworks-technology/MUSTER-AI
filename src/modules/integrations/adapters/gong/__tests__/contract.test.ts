import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedTranscript } from "../../../normalized";
import { gongAdapter } from "..";

const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_gong",
    integrationId: "int_gong",
    credentials: {
      username: "fixture-gong-key",
      apiKey: "fixture-gong-secret",
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("gong", "calls"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of gongAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Gong contract", () => {
  it("validates API credentials", async () => {
    const t = world();
    await expect(
      gongAdapter.auth.kind === "apiKey"
        ? gongAdapter.auth.validate({ username: "fixture-gong-key", apiKey: "fixture-gong-secret" }, t)
        : Promise.reject(new Error("not apiKey")),
    ).resolves.toBeUndefined();
  });

  it("tests connection successfully", async () => {
    const t = world();
    const res = await gongAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Gong (Leo Marsh)");
    expect(res.externalAccountId).toBe("gong-user-1");
  });

  it("syncs calls and transcripts into NormalizedTranscript batch", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.kind).toBe("transcripts");
    const records = batches[0]!.records as NormalizedTranscript[];
    expect(records).toHaveLength(1);
    expect(records[0]!.externalId).toBe("gong-call-1");
    expect(records[0]!.title).toBe("Brightwell Quarterly Business Review");
    expect(records[0]!.attendeeEmails).toEqual(["leo@larkspur.test", "ben.okafor@brightwell.test"]);
    expect(records[0]!.text).toContain("Welcome everyone to our QBR.");
    expect(records[0]!.text).toContain("We have seen great results with our shipment SLAs.");
  });
});
