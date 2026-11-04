import { describe, expect, it } from "vitest";
import { BRIER_MARGIN, calibrate, chooseModel, type Sample } from "../calibration";

const s = (confidence: number, renewed: boolean): Sample => ({
  confidence,
  renewed,
  band: confidence >= 70 ? "HIGH" : confidence >= 40 ? "MEDIUM" : "LOW",
});

describe("calibration (M7 rule 2: reported as measured)", () => {
  it("counts renewed and churned per band and per score bucket; an empty bucket has no share", () => {
    const c = calibrate([
      s(90, true),
      s(85, true),
      s(80, false),
      s(55, true),
      s(30, false),
      s(10, false),
    ]);
    expect(c.byBand.map((b) => [b.label, b.n, b.renewed, b.churned, b.renewedShare])).toEqual([
      ["HIGH", 3, 2, 1, 0.6667],
      ["MEDIUM", 1, 1, 0, 1],
      ["LOW", 2, 0, 2, 0],
    ]);
    expect(c.byScore.map((b) => [b.label, b.n, b.renewedShare])).toEqual([
      ["80–100", 3, 0.6667],
      ["60–79", 0, null],
      ["40–59", 1, 1],
      ["0–39", 2, 0],
    ]);
  });

  it("Brier: 0 is perfect, always-50 is 0.25; AUC: ties count half, one-sided data has none", () => {
    expect(calibrate([s(100, true), s(0, false)]).brier).toBe(0);
    expect(calibrate([s(50, true), s(50, false)]).brier).toBe(0.25);
    expect(calibrate([s(80, true), s(20, false)]).auc).toBe(1);
    expect(calibrate([s(50, true), s(50, false)]).auc).toBe(0.5);
    expect(calibrate([s(20, true), s(80, false)]).auc).toBe(0);
    expect(calibrate([s(80, true)]).auc).toBeNull();
    expect(calibrate([]).brier).toBeNull();
  });

  it("the simple model ships unless the factor model wins by more than the margin (D-118)", () => {
    expect(chooseModel(0.2, 0.25)).toBe("factor");
    expect(chooseModel(0.25 - BRIER_MARGIN, 0.25)).toBe("simple"); // exactly the margin is not enough
    expect(chooseModel(0.3, 0.25)).toBe("simple");
    expect(chooseModel(null, 0.25)).toBe("simple");
  });
});
