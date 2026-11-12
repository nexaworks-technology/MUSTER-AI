import { describe, expect, it } from "vitest";
import {
  GLOBALS_CSS,
  blockBody,
  contrast,
  declarations,
  over,
  parseOklch,
  resolve,
  type Rgba,
} from "@/test/css-tokens";

/**
 * Design 3.0 token layer: both themes carry the full token set, every text and boundary pair
 * passes WCAG AA (text 4.5:1, UI boundaries 3:1), glass panels keep text readable over the worst
 * backdrop, and live blur exists only on fixed chrome (never on cards or panels).
 */
const root = declarations(blockBody(GLOBALS_CSS, "\n:root {"));
const darkExplicit = declarations(blockBody(GLOBALS_CSS, '\n:root[data-theme="dark"] {'));
const darkSystem = declarations(
  blockBody(blockBody(GLOBALS_CSS, "@media (prefers-color-scheme: dark)"), ":root:not("),
);
const scope = declarations(blockBody(GLOBALS_CSS, ".glass-surfaces {"));

const themes = { light: root, dark: { ...root, ...darkExplicit } } as const;

function colour(theme: "light" | "dark", name: string, ...extra: Record<string, string>[]): Rgba {
  const layers = [themes[theme], ...extra];
  const key = `--${name}`;
  const value = layers.reduce<string | undefined>((v, l) => l[key] ?? v, undefined);
  if (value === undefined) throw new Error(`${theme}: missing ${name}`);
  return parseOklch(resolve(value, ...layers));
}

const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["primary-foreground", "primary"],
  ["primary", "background"],
  ["primary", "card"],
  ["accent-foreground", "accent"],
  ["success-foreground", "success"],
  ["success", "card"],
  ["success-soft-foreground", "success-soft"],
  ["warning-foreground", "warning"],
  ["warning", "card"],
  ["warning-soft-foreground", "warning-soft"],
  ["danger-foreground", "danger"],
  ["danger", "card"],
  ["danger-soft-foreground", "danger-soft"],
  ["primary-foreground", "accent-from"],
  ["primary-foreground", "accent-to"],
  ["risk-unknown", "card"],
  ["risk-unknown-soft-foreground", "risk-unknown-soft"],
];

/** The Ask AI conversation area (warm paper, terracotta accent): text 4.5:1, graphics 3:1. */
const ASK_TEXT_PAIRS: [string, string][] = [
  ["foreground", "ask-paper"],
  ["muted-foreground", "ask-paper"],
  ["ask-accent-text", "ask-paper"],
  ["foreground", "ask-bubble"],
  ["foreground", "ask-wash"],
  ["muted-foreground", "ask-wash"],
  ["foreground", "ask-pill"],
  ["ask-accent-text", "ask-pill"],
  ["background", "ask-accent-text"], // text on the Yes, do it button
  ["foreground", "ask-composer"],
  ["muted-foreground", "ask-composer"],
];
const ASK_GRAPHIC_PAIRS: [string, string][] = [
  ["ask-accent", "ask-paper"], // the starburst mark on the page
  ["ask-accent-foreground", "ask-accent"], // the arrow on the send button
  ["ask-accent", "ask-composer"], // the send button against the composer
];

describe("theme token layer", () => {
  it("dark is declared twice, for the explicit toggle and for system, and the two match", () => {
    expect(Object.keys(darkExplicit).length).toBeGreaterThan(30);
    expect(darkSystem).toEqual(darkExplicit);
  });

  it("dark overrides every colour token the light theme defines", () => {
    const colourTokens = Object.entries(root)
      .filter(([, v]) => v.includes("oklch(") && !v.includes("gradient"))
      .map(([k]) => k);
    const missing = colourTokens.filter((k) => !(k in darkExplicit));
    expect(missing).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    describe(`${theme}: solid tokens`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        it(`${fg} on ${bg} is at least 4.5:1`, () => {
          expect(contrast(colour(theme, fg), colour(theme, bg))).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const [fg, bg] of ASK_TEXT_PAIRS) {
        it(`ask: ${fg} on ${bg} is at least 4.5:1`, () => {
          expect(contrast(colour(theme, fg), colour(theme, bg))).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const [fg, bg] of ASK_GRAPHIC_PAIRS) {
        it(`ask: ${fg} against ${bg} is at least 3:1`, () => {
          expect(contrast(colour(theme, fg), colour(theme, bg))).toBeGreaterThanOrEqual(3);
        });
      }
      it("focus ring and field boundary are at least 3:1 against card", () => {
        expect(contrast(colour(theme, "ring"), colour(theme, "card"))).toBeGreaterThanOrEqual(3);
        expect(contrast(colour(theme, "input"), colour(theme, "card"))).toBeGreaterThanOrEqual(3);
      });
    });

    describe(`${theme}: glass over the worst ambient backdrop`, () => {
      const backdrops = ["ambient-base", "ambient-a", "ambient-b", "ambient-c", "ambient-d"].map(
        (n) => colour(theme, n),
      );
      const glass = (name: string, backdrop: Rgba) => over(colour(theme, name, scope), backdrop);

      it("panel text (foreground, muted) is at least 4.5:1 on the panel fill", () => {
        for (const backdrop of backdrops) {
          const panel = glass("card", backdrop);
          expect(contrast(colour(theme, "foreground"), panel)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "muted-foreground"), panel)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "primary"), panel)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "danger"), panel)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("table header and hover tints stay readable (muted over the panel)", () => {
        for (const backdrop of backdrops) {
          const panel = glass("card", backdrop);
          for (const tint of ["muted", "hover"]) {
            const t = over(colour(theme, tint, scope), panel);
            expect(contrast(colour(theme, "foreground"), t)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(colour(theme, "muted-foreground"), t)).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("table and dense-grid text sits on a near-solid data fill: at least 4.5:1", () => {
        for (const backdrop of backdrops) {
          const data = over(
            colour(theme, "glass-data"),
            over(colour(theme, "card", scope), backdrop),
          );
          expect(contrast(colour(theme, "foreground"), data)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "muted-foreground"), data)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "primary"), data)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "danger"), data)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("sticky table headers are fully opaque", () => {
        expect(parseOklch(resolve(themes[theme]["--glass-solid-muted"]!)).a).toBe(1);
      });

      it("fixed chrome (sidebar, top bar) text is at least 4.5:1 on its fill", () => {
        for (const backdrop of backdrops) {
          const chrome = over(colour(theme, "glass-chrome-fill"), backdrop);
          expect(contrast(colour(theme, "foreground"), chrome)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(colour(theme, "muted-foreground"), chrome)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("the glass hairline border is visible (at least 1.15:1) against the panel", () => {
        for (const backdrop of backdrops) {
          const panel = glass("card", backdrop);
          const border = over(colour(theme, "border", scope), panel);
          expect(contrast(border, panel)).toBeGreaterThanOrEqual(1.15);
        }
      });
    });
  }
});

describe("glass rules", () => {
  // Comments and @supports conditions mention backdrop-filter without applying it.
  const css = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /@supports[^{]*\{/g,
    "@supports {",
  );

  it("live backdrop blur appears only in the chrome and popover utilities and nowhere else", () => {
    const uses = [...css.matchAll(/backdrop-filter\s*:\s*(blur|none)/g)].length;
    const inChrome = [...blockBody(css, "@utility glass-chrome").matchAll(/backdrop-filter\s*:/g)];
    const inPopover = [
      ...blockBody(css, "@utility glass-popover").matchAll(/backdrop-filter\s*:/g),
    ];
    // Each of the two utilities sets it once, plus one reset in the reduced-transparency block each.
    expect(inChrome.length).toBeGreaterThanOrEqual(1);
    expect(inPopover.length).toBeGreaterThanOrEqual(1);
    expect(uses).toBe(
      inChrome.length + inPopover.length + [...css.matchAll(/backdrop-filter\s*:\s*none/g)].length,
    );
  });

  it("surface, surface-interactive and the glass scope never blur", () => {
    for (const sel of [
      "@utility surface {",
      "@utility surface-interactive {",
      ".glass-surfaces {",
    ]) {
      expect(blockBody(css, sel)).not.toMatch(/backdrop-filter/);
    }
  });

  it("scope turns off the sticky-header blur of data lists", () => {
    expect(css).toMatch(/\.glass-surfaces\s+\.backdrop-blur-sm[^}]*backdrop-filter\s*:\s*none/);
  });

  it("reduced transparency gives solid chrome and solid panels", () => {
    const rt = blockBody(css, "@media (prefers-reduced-transparency: reduce)");
    expect(rt).toMatch(/--glass-chrome-fill/);
    expect(rt).toMatch(/backdrop-filter\s*:\s*none/);
    expect(rt).toMatch(/--glass-panel-1/);
  });

  it("reduced motion removes the glass transitions and hover lift", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("chrome has a solid fallback where backdrop-filter is unsupported", () => {
    expect(GLOBALS_CSS).toMatch(/@supports not \(\(?backdrop-filter/);
  });
});
