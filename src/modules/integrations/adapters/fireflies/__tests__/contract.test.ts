import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedTranscript } from "../../../normalized";
import { firefliesAdapter } from "..";

const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws_ff",
    integrationId: "int_ff",
    credentials: {
      apiKey: "fixture-ff-key",
    },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("fireflies", "transcripts"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of firefliesAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Fireflies contract", () => {
  it("validates API key", async () => {
    const t = world();
    await expect(
      firefliesAdapter.auth.kind === "apiKey"
        ? firefliesAdapter.auth.validate({ apiKey: "fixture-ff-key" }, t)
        : Promise.reject(new Error("not apiKey")),
    ).resolves.toBeUndefined();
  });

  it("tests connection successfully", async () => {
    const t = world();
    const res = await firefliesAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Fireflies (Leo Marsh)");
    expect(res.externalAccountId).toBe("ff-user-1");
  });

  it("syncs transcripts into NormalizedTranscript batch", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.kind).toBe("transcripts");
    const records = batches[0]!.records as NormalizedTranscript[];
    expect(records).toHaveLength(1);
    expect(records[0]!.externalId).toBe("ff-trans-1");
    expect(records[0]!.title).toBe("Brightwell Logistics Quarterly Catchup");
    expect(records[0]!.attendeeEmails).toEqual(["leo@larkspur.test", "ben.okafor@brightwell.test"]);
    expect(records[0]!.text).toContain("Ben Okafor: Glad to be here.");
  });
});
