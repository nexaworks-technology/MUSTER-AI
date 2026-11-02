import { describe, expect, it } from "vitest";
import { applyCurve, curveSchema } from "../engine/curves";
import { DEFAULT_COMPONENT_CONFIG } from "../engine/model";

describe("piecewise-linear curves", () => {
  const ratio = [
    [0.2, 0],
    [0.5, 40],
    [0.8, 75],
    [1, 100],
  ] as [number, number][];

  it("hits every breakpoint exactly and interpolates between them", () => {
    expect(applyCurve(ratio, 0.2)).toBe(0);
    expect(applyCurve(ratio, 0.5)).toBe(40);
    expect(applyCurve(ratio, 0.8)).toBe(75);
    expect(applyCurve(ratio, 1)).toBe(100);
    expect(applyCurve(ratio, 0.65)).toBeCloseTo(57.5, 10);
    expect(applyCurve(ratio, 0.35)).toBeCloseTo(20, 10);
  });

  it("clamps beyond the first and last points", () => {
    expect(applyCurve(ratio, 0)).toBe(0);
    expect(applyCurve(ratio, -3)).toBe(0);
    expect(applyCurve(ratio, 1.4)).toBe(100);
    expect(applyCurve(ratio, 1e9)).toBe(100);
  });

  it("works for falling curves (more days → lower score)", () => {
    const days = [
      [14, 100],
      [30, 75],
      [90, 0],
    ] as [number, number][];
    expect(applyCurve(days, 0)).toBe(100);
    expect(applyCurve(days, 22)).toBeCloseTo(87.5, 10);
    expect(applyCurve(days, 365)).toBe(0);
  });

  it("refuses curves that are unsorted, out of range or too short", () => {
    expect(curveSchema.safeParse([[1, 50]]).success).toBe(false);
    expect(
      curveSchema.safeParse([
        [1, 50],
        [0.5, 60],
      ]).success,
    ).toBe(false);
    expect(
      curveSchema.safeParse([
        [0, -1],
        [1, 100],
      ]).success,
    ).toBe(false);
    expect(
      curveSchema.safeParse([
        [0, 0],
        [1, 101],
      ]).success,
    ).toBe(false);
    expect(
      curveSchema.safeParse([
        [0, 0],
        [0, 100],
      ]).success,
    ).toBe(false);
  });

  it("every default curve is valid and moves in one direction only", () => {
    for (const [pillar, components] of Object.entries(DEFAULT_COMPONENT_CONFIG)) {
      for (const [name, c] of Object.entries(components)) {
        if (!("curve" in c) || !c.curve) continue;
        expect(curveSchema.safeParse(c.curve).success, `${pillar}.${name}`).toBe(true);
        const scores = c.curve.map(([, y]) => y);
        const up = scores.every((y, i) => i === 0 || y >= scores[i - 1]!);
        const down = scores.every((y, i) => i === 0 || y <= scores[i - 1]!);
        expect(up || down, `${pillar}.${name} is monotonic`).toBe(true);
        // Clamped to 0–100 everywhere, including far outside the breakpoints.
        for (const x of [-1e6, -1, 0, 0.5, 1, 7, 30, 1e6]) {
          const y = applyCurve(c.curve, x);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});
