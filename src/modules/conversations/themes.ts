import { z } from "zod";

/**
 * The fixed theme list (M9 D5). A theme groups complaints and repeat problems only when it is on
 * this list; `other` and free-text labels never group, because code cannot tell whether two
 * free-text themes mean the same thing. The list is the `extraction.themes` workspace setting,
 * audited like every setting, and is also the list the Watcher prompt offers the model.
 */
export const DEFAULT_THEMES: readonly string[] = [
  "csv_export",
  "api_limits",
  "billing",
  "performance",
  "integrations",
  "onboarding",
  "reporting",
  "access_permissions",
  "data_quality",
  "other",
];

const KEY = /^[a-z][a-z0-9_]*$/;

export const themeSettingSchema = z
  .array(z.string().regex(KEY))
  .min(1)
  .max(40)
  .refine((l) => new Set(l).size === l.length, "duplicate theme")
  .refine((l) => l.includes("other"), "the list must keep `other`");

/** The list entry a model label matches (case and surrounding space ignored), or null. */
export function groupableTheme(label: string, list: readonly string[]): string | null {
  const k = label.trim().toLowerCase();
  return k !== "other" && list.includes(k) ? k : null;
}
