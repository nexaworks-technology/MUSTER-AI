import { describe, expect, it } from "vitest";
import { liveSnapshotWhere } from "../live";

describe("liveSnapshotWhere (D-158)", () => {
  it("always excludes back-test rows", () => {
    expect(liveSnapshotWhere()).toEqual({ isBacktest: false });
  });

  it("merges extra conditions", () => {
    expect(liveSnapshotWhere({ accountId: "a1" })).toEqual({ accountId: "a1", isBacktest: false });
  });

  it("cannot be overridden to include back-tests", () => {
    expect(liveSnapshotWhere({ isBacktest: true })).toEqual({ isBacktest: false });
  });
});
