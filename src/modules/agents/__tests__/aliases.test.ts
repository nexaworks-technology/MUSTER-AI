import { describe, expect, it } from "vitest";
import { resolveHandles, withHandles } from "../aliases";
import type { ContextBundle } from "../schemas";

const bundle: ContextBundle = [
  { sourceType: "Account", sourceId: "acc_aaaaaaaaaaaaaaaaaaaa", fields: { name: "Zenith" } },
  { sourceType: "Signal", sourceId: "sig_bbbbbbbbbbbbbbbbbbbb", fields: { title: "Usage drop" } },
];

describe("cite handles", () => {
  it("shows each record with a handle first, and leaves the record's own fields untouched", () => {
    const shown = withHandles(bundle);
    expect(shown.map((r) => r.cite)).toEqual(["R1", "R2"]);
    expect(shown[0]).toEqual({ cite: "R1", ...bundle[0] });
    // The handle is not a field: a number in it can never make a number "appear" in a record.
    expect(shown[0]!.fields).toEqual({ name: "Zenith" });
  });

  it("turns a handle into the real record, taking the type from the record, not from the model", () => {
    const out = resolveHandles(
      {
        citations: [{ sourceType: "Whatever", sourceId: "R2", quote: "q" }],
        figures: [{ value: "1", sourceType: "X", sourceId: "R1", field: "name" }],
        answer: "R1 stays text",
      },
      bundle,
    ) as { citations: unknown[]; figures: unknown[]; answer: string };
    expect(out.citations).toEqual([
      { sourceType: "Signal", sourceId: "sig_bbbbbbbbbbbbbbbbbbbb", quote: "q" },
    ]);
    expect(out.figures).toEqual([
      { value: "1", sourceType: "Account", sourceId: "acc_aaaaaaaaaaaaaaaaaaaa", field: "name" },
    ]);
    expect(out.answer).toBe("R1 stays text");
  });

  it("never widens what can be cited: an unknown handle, a real id and a mangled id are left as written", () => {
    const cites = [
      { sourceType: "Signal", sourceId: "R99" },
      { sourceType: "Account", sourceId: "acc_aaaaaaaaaaaaaaaaaaaa" },
      { sourceType: "Signal", sourceId: "sig_bbbbbbbbbbbbbbbbbbbb".slice(0, 12) + "XXXXXXXX" },
      { sourceType: "Signal", sourceId: "R0" },
      { sourceType: "Signal", sourceId: "r1" },
    ];
    expect(
      (resolveHandles({ citations: cites }, bundle) as { citations: unknown[] }).citations,
    ).toEqual(cites);
  });

  it("passes anything that is not an object straight through", () => {
    expect(resolveHandles(null, bundle)).toBeNull();
    expect(resolveHandles("x", bundle)).toBe("x");
  });
});
