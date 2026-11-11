/**
 * Test helper: reads the design tokens out of src/app/globals.css and computes WCAG contrast from
 * the oklch values, so the contrast tables in the CSS comments are checked, not just written.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const GLOBALS_CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

/** The text between the braces of the first block whose selector line matches `selector`. */
export function blockBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block: ${selector}`);
}

/** `--name: value;` declarations of one block body (comments removed). */
export function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.replace(/\s+/g, " ").trim();
  return out;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Resolve `var(--x)` chains against the given layers (later layers win). */
export function resolve(value: string, ...layers: Record<string, string>[]): string {
  let v = value;
  for (let i = 0; i < 10 && v.includes("var("); i++) {
    v = v.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
      for (let j = layers.length - 1; j >= 0; j--) {
        const hit = layers[j]![name];
        if (hit !== undefined) return hit;
      }
      throw new Error(`unresolved ${name}`);
    });
  }
  return v;
}

const lin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** oklch(L C H / A) to clamped sRGB 0..1. */
export function parseOklch(value: string): Rgba {
  const m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (!m) throw new Error(`not an oklch colour: ${value}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4]);
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const mm = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, lin(x)));
  return {
    r: clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    g: clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    b: clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    a,
  };
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function luminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG 2.x contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
