import { describe, expect, it } from "vitest";
import { usageChangePoints } from "../change-points";

const weeks = (values: number[]) =>
  values.map((v, i) => ({ weekStart: new Date(Date.UTC(2026, 0, 5 + i * 7)), avgActive: v }));

describe("usage change points", () => {
  it("reports a drop of 30% or more against the previous four weeks, once per run", () => {
    const points = usageChangePoints(weeks([40, 41, 39, 40, 26, 22, 18, 17]));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ direction: "down", pct: 35, baseline: 40 });
  });

  it("reports a recovery as a separate upward point", () => {
    const points = usageChangePoints(weeks([10, 10, 10, 10, 5, 5, 5, 5, 10, 10]));
    expect(points.map((p) => p.direction)).toEqual(["down", "up"]);
  });

  it("ignores small accounts and normal wobble", () => {
    expect(usageChangePoints(weeks([2, 2, 2, 2, 0, 0]))).toEqual([]);
    expect(usageChangePoints(weeks([40, 44, 38, 41, 36, 45]))).toEqual([]);
  });

  it("needs four weeks of history before judging a week", () => {
    expect(usageChangePoints(weeks([40, 10, 10]))).toEqual([]);
  });
});
