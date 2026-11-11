/**
 * Theme preference (Design 3.0). The choice is stored in a plain cookie so the server can put
 * `data-theme` on <html> before the first paint (no flash, no inline script, nothing for the CSP
 * to allow). "system" is stored as no attribute at all: the CSS follows `prefers-color-scheme`.
 */
export const THEME_COOKIE = "nx-theme";
export const THEMES = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof THEMES)[number];

/** Anything that is not exactly "light" or "dark" is the default, "system". */
export function parseTheme(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The `data-theme` attribute value, or undefined for "system" (CSS follows the OS). */
export function themeAttribute(theme: ThemeChoice): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

/** The Set-Cookie string for a choice, one year, readable by the toggle (not HttpOnly). */
export function themeCookie(theme: ThemeChoice, secure: boolean): string {
  const base = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
  return secure ? `${base}; Secure` : base;
}
