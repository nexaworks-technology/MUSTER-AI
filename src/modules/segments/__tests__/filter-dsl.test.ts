import { describe, expect, it } from "vitest";
import { compileSegment, segmentFilter } from "../dsl";

const NOW = new Date("2026-11-02T14:00:00Z");
const ctx = { now: NOW, arrScale: 100n, canViewRevenue: true };

describe("segment filter DSL", () => {
  it("accepts known fields and compiles to a Prisma where (AND of conditions)", () => {
    const filter = segmentFilter.parse({
      all: [
        { field: "tier", op: "in", value: ["LONG_TAIL"] },
        { field: "lifecycleStage", op: "eq", value: "ADOPTING" },
        { field: "industry", op: "contains", value: "retail" },
      ],
    });
    expect(compileSegment(filter, ctx)).toEqual({
      AND: [
        { tier: { in: ["LONG_TAIL"] } },
        { lifecycleStage: "ADOPTING" },
        { industry: { contains: "retail", mode: "insensitive" } },
      ],
    });
  });

  it("rejects unknown fields and wrong operators", () => {
    expect(
      segmentFilter.safeParse({ all: [{ field: "workspaceId", op: "eq", value: "x" }] }).success,
    ).toBe(false);
    expect(
      segmentFilter.safeParse({ all: [{ field: "passwordHash", op: "eq", value: "x" }] }).success,
    ).toBe(false);
    expect(
      segmentFilter.safeParse({ all: [{ field: "tier", op: "contains", value: "x" }] }).success,
    ).toBe(false);
    expect(
      segmentFilter.safeParse({ all: [{ field: "tier", op: "eq", value: "PLATINUM" }] }).success,
    ).toBe(false);
  });

  it("compiles ARR bands in major units to minor units", () => {
    const filter = segmentFilter.parse({
      all: [{ field: "arr", op: "between", value: [10_000, 50_000] }],
    });
    expect(compileSegment(filter, ctx)).toEqual({
      AND: [{ arrMinor: { gte: 1_000_000n, lte: 5_000_000n } }],
    });
  });

  it("refuses ARR conditions for members without revenue access (no leak by filtering)", () => {
    const filter = segmentFilter.parse({ all: [{ field: "arr", op: "gte", value: 50_000 }] });
    expect(() => compileSegment(filter, { ...ctx, canViewRevenue: false })).toThrow(/revenue/);
  });

  it("renewal within the next N days is a date range from now", () => {
    const filter = segmentFilter.parse({
      all: [{ field: "renewalDate", op: "withinNextDays", value: 90 }],
    });
    expect(compileSegment(filter, ctx)).toEqual({
      AND: [{ renewalDate: { gte: NOW, lte: new Date(NOW.getTime() + 90 * 86_400_000) } }],
    });
  });

  it("owner can be a member or nobody", () => {
    const filter = segmentFilter.parse({ all: [{ field: "owner", op: "eq", value: "none" }] });
    expect(compileSegment(filter, ctx)).toEqual({ AND: [{ ownerMembershipId: null }] });
  });

  it("caps the number of conditions", () => {
    expect(
      segmentFilter.safeParse({
        all: Array.from({ length: 21 }, () => ({ field: "plan", op: "eq", value: "x" })),
      }).success,
    ).toBe(false);
  });
});
