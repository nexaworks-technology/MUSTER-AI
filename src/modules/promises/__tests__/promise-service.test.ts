import { describe, expect, it } from "vitest";
import { promiseDedupeKey, sortPromises } from "../service";

/** Pure parts of the Promise service (M9 §5): dedupe on the same quote, and the tracker's order. */
describe("promiseDedupeKey", () => {
  it("is the same for the same source and quote, however the whitespace falls", () => {
    const a = promiseDedupeKey(
      "CALL_TRANSCRIPT",
      "t1",
      "Engineering will  have the fix\nby October 24.",
    );
    const b = promiseDedupeKey(
      "CALL_TRANSCRIPT",
      "t1",
      "Engineering will have the fix by October 24.",
    );
    expect(a).toBe(b);
  });
  it("differs by source and by quote", () => {
    const q = "We will fix it";
    expect(promiseDedupeKey("MESSAGE", "m1", q)).not.toBe(promiseDedupeKey("MESSAGE", "m2", q));
    expect(promiseDedupeKey("MESSAGE", "m1", q)).not.toBe(
      promiseDedupeKey("MESSAGE", "m1", `${q} soon`),
    );
  });
});

type Row = {
  id: string;
  status: "OPEN" | "KEPT" | "LATE" | "BROKEN";
  ownerMembershipId: string | null;
  dueDate: string | null;
};
const row = (
  id: string,
  status: Row["status"],
  owner: string | null,
  dueDate: string | null,
): Row => ({
  id,
  status,
  ownerMembershipId: owner,
  dueDate,
});

describe("sortPromises: late first, then no owner, then due ascending", () => {
  it("orders the tracker", () => {
    const rows = [
      row("open-owned-late-due", "OPEN", "m1", "2026-12-01"),
      row("open-owned-soon", "OPEN", "m1", "2026-11-05"),
      row("open-noowner-nodate", "OPEN", null, null),
      row("late-owned", "LATE", "m1", "2026-10-30"),
      row("broken-noowner", "BROKEN", null, "2026-10-01"),
      row("open-noowner-dated", "OPEN", null, "2026-11-20"),
      row("kept", "KEPT", "m1", "2026-10-01"),
    ];
    expect(sortPromises(rows).map((r) => r.id)).toEqual([
      "broken-noowner", // late class (broken counts as late), earliest due first
      "late-owned",
      "open-noowner-dated", // then no owner, due ascending, undated last
      "open-noowner-nodate",
      "open-owned-soon", // then the rest by due date
      "open-owned-late-due",
      "kept", // kept sinks to the bottom
    ]);
  });
  it("does not mutate its input", () => {
    const rows = [row("b", "OPEN", "m", "2026-11-09"), row("a", "LATE", "m", "2026-11-01")];
    sortPromises(rows);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
  });
});
