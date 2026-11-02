import { z } from "zod";

/**
 * Piecewise-linear scoring curves (ARCHITECTURE §4.1): points [x, score] sorted by x, straight
 * lines between them, flat beyond the first and last point, scores 0–100.
 */
export type Curve = Array<[x: number, score: number]>;

export const curveSchema = z
  .array(z.tuple([z.number().finite(), z.number().min(0).max(100)]))
  .min(2)
  .refine((pts) => pts.every((p, i) => i === 0 || p[0] > pts[i - 1]![0]), {
    message: "Curve points must be sorted by x with no repeats",
  });

export function applyCurve(curve: Curve, x: number): number {
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]!;
    if (x <= x1) {
      const [x0, y0] = curve[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}
