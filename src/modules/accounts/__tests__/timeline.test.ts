import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, mergeTimeline, type TimelineItem } from "../timeline";

const item = (key: string, iso: string): TimelineItem => ({
  key,
  at: new Date(iso),
  kind: "note",
  title: key,
  sourceType: "Note",
  sourceId: key,
});

const a = [item("note:3", "2026-10-03T10:00:00Z"), item("note:1", "2026-10-01T10:00:00Z")];
const b = [item("task:2", "2026-10-02T10:00:00Z"), item("task:9", "2026-10-03T10:00:00Z")];
const c = [item("msg:5", "2026-10-03T10:00:00Z"), item("msg:4", "2026-09-30T10:00:00Z")];

describe("timeline merge", () => {
  it("merges every source newest first, breaking ties by key", () => {
    const { items } = mergeTimeline([a, b, c], null, 10);
    expect(items.map((i) => i.key)).toEqual([
      "msg:5",
      "note:3",
      "task:9",
      "task:2",
      "note:1",
      "msg:4",
    ]);
  });

  it("pages through all items exactly once with a stable cursor", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = mergeTimeline([a, b, c], cursor ? decodeCursor(cursor) : null, 2);
      seen.push(...page.items.map((i) => i.key));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(mergeTimeline([a, b, c], null, 100).items.map((i) => i.key));
  });

  it("the cursor survives a round trip and rejects junk", () => {
    const cur = { at: new Date("2026-10-03T10:00:00Z"), key: "note:3" };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });

  it("an item added later with an older timestamp does not shift pages already seen", () => {
    const first = mergeTimeline([a, b, c], null, 3);
    const late = [item("note:0", "2026-09-01T00:00:00Z")];
    const second = mergeTimeline([a, b, c, late], decodeCursor(first.nextCursor!), 3);
    expect(second.items.map((i) => i.key)).toEqual(["task:2", "note:1", "msg:4"]);
  });

  it("returns no next cursor on the last page", () => {
    expect(mergeTimeline([a], null, 5).nextCursor).toBeNull();
  });
});
