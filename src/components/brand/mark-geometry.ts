/**
 * The Muster AI mark: two interlocking ribbons forming an M. One source of geometry for the
 * React component, the favicon SVG and the generated PNG icons (scripts/brand-icons.ts).
 *
 * Each ribbon rises as an outer leg, turns over a rounded lobe, and falls diagonally across the
 * middle; the right ribbon passes OVER the left at the crossing (a gap is cut from the left one).
 * At small sizes the gap and a thin stroke muddy, so the `small` variant drops the gap and draws
 * the ribbons slightly heavier.
 */
export const MARK_VIEWBOX = "0 0 64 48";
export const MARK_ASPECT = 64 / 48;

/** The ribbon width, in viewBox units: also the clearspace unit (docs/BRAND.md). */
export const RIBBON = 7.5;
export const RIBBON_SMALL = 9;
/** The gap either side of the over-ribbon at the crossing. */
export const CROSS_GAP = 2.25;

/** Left ribbon: leg, lobe, diagonal down-right. */
export const LEFT_RIBBON = "M10 41 V20 A8 8 0 0 1 26 20 L39.5 40";
/** Right ribbon: leg, lobe, diagonal down-left. */
export const RIGHT_RIBBON = "M54 41 V20 A8 8 0 0 0 38 20 L24.5 40";
/** The part of the right ribbon that crosses over the left one (the mask cut follows it). */
export const RIGHT_CROSSING = "M38 20 L24.5 40";

/** Brand colours (sRGB hex). Recorded in docs/BRAND.md. */
export const BRAND = {
  violet: "#5B2A7A",
  warmWhite: "#F6EFE6",
} as const;

/** A standalone SVG string (favicon, PNG generation). `small` is the 16-32 px drawing. */
export function markSvg(color: string, opts: { small?: boolean; size?: number } = {}): string {
  const w = opts.small ? RIBBON_SMALL : RIBBON;
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : "";
  const stroke = `fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
  // Square canvas for icons: the 64x48 drawing centred vertically.
  const body = opts.small
    ? `<path d="${LEFT_RIBBON}" ${stroke}/><path d="${RIGHT_RIBBON}" ${stroke}/>`
    : `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="48"><rect width="64" height="48" fill="#fff"/><path d="${RIGHT_CROSSING}" stroke="#000" stroke-width="${w + 2 * CROSS_GAP}" fill="none"/></mask></defs><path d="${LEFT_RIBBON}" ${stroke} mask="url(#m)"/><path d="${RIGHT_RIBBON}" ${stroke}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -8 64 64"${size}>${body}</svg>`;
}
