import { describe, expect, it } from "vitest";
import {
  planReextract,
  planSources,
  reextractPayload,
  StaleReextractError,
  triggerIdFor,
} from "../extract";

const V = "1.1.0";
const inputs = {
  messages: [
    { id: "m1", direction: "INBOUND" as const },
    { id: "m2", direction: "OUTBOUND" as const },
  ],
  notes: [{ id: "n1" }],
  transcripts: [{ id: "t1", chunks: 3 }],
};

describe("extraction trigger ids", () => {
  it("keep the M4 shape for messages and notes and add the chunk for calls", () => {
    expect(triggerIdFor({ sourceType: "MESSAGE", sourceId: "m1", chunkIndex: 0 }, V)).toBe("MESSAGE:m1@1.1.0");
    expect(triggerIdFor({ sourceType: "NOTE", sourceId: "n1", chunkIndex: 0 }, V)).toBe("NOTE:n1@1.1.0");
    expect(triggerIdFor({ sourceType: "CALL_TRANSCRIPT", sourceId: "t1", chunkIndex: 2 }, V)).toBe(
      "CALL_TRANSCRIPT:t1#2@1.1.0",
    );
  });
});

describe("planSources (what the Watcher still has to read)", () => {
  it("lists every message (both directions), note and call chunk without a run at this version", () => {
    const s = planSources({ ...inputs, done: new Set(), version: V });
    expect(s.map((x) => x.triggerId)).toEqual([
      "MESSAGE:m1@1.1.0",
      "MESSAGE:m2@1.1.0",
      "NOTE:n1@1.1.0",
      "CALL_TRANSCRIPT:t1#0@1.1.0",
      "CALL_TRANSCRIPT:t1#1@1.1.0",
      "CALL_TRANSCRIPT:t1#2@1.1.0",
    ]);
  });
  it("skips what already ran at this version, and only that", () => {
    const done = new Set(["MESSAGE:m1@1.1.0", "CALL_TRANSCRIPT:t1#1@1.1.0", "MESSAGE:m2@1.0.0"]);
    const s = planSources({ ...inputs, done, version: V });
    expect(s.map((x) => x.triggerId)).toEqual([
      "MESSAGE:m2@1.1.0",
      "NOTE:n1@1.1.0",
      "CALL_TRANSCRIPT:t1#0@1.1.0",
      "CALL_TRANSCRIPT:t1#2@1.1.0",
    ]);
  });
  it("honours a limit", () => {
    expect(planSources({ ...inputs, done: new Set(), version: V, limit: 2 })).toHaveLength(2);
  });
});

describe("planReextract (only on an explicit prompt-version bump)", () => {
  it("re-reads only sources that an earlier version already read", () => {
    const done = new Set(["MESSAGE:m1@1.0.0", "NOTE:n1@1.0.0", "CALL_TRANSCRIPT:t1#0@1.0.0"]);
    const s = planReextract({ ...inputs, done, version: V });
    expect(s.map((x) => x.triggerId)).toEqual([
      "MESSAGE:m1@1.1.0",
      "NOTE:n1@1.1.0",
      "CALL_TRANSCRIPT:t1#0@1.1.0",
    ]);
  });
  it("refuses when no earlier version ever ran (that is a backfill, not a re-extraction)", () => {
    expect(() => planReextract({ ...inputs, done: new Set(), version: V })).toThrow(StaleReextractError);
  });
  it("is empty once every earlier-read source has been read at this version", () => {
    const done = new Set(["MESSAGE:m1@1.0.0", "MESSAGE:m1@1.1.0"]);
    expect(planReextract({ ...inputs, done, version: V })).toEqual([]);
  });
});

describe("the conversations.reextract payload carries ids only (Rule 7, S1 lesson)", () => {
  it("accepts the workspace and the prompt version", () => {
    expect(reextractPayload.parse({ workspaceId: "w1", promptVersion: "1.1.0" })).toEqual({
      workspaceId: "w1",
      promptVersion: "1.1.0",
    });
  });
  it("rejects any extra field, so no customer text can ride along", () => {
    expect(reextractPayload.safeParse({ workspaceId: "w1", promptVersion: "1.1.0", text: "hello" }).success).toBe(false);
  });
});
