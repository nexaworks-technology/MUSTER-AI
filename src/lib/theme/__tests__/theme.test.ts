import { describe, expect, it } from "vitest";
import { THEME_COOKIE, parseTheme, themeAttribute, themeCookie } from "../index";

describe("theme preference", () => {
  it("defaults to system for anything but light or dark", () => {
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("DARK")).toBe("system");
    expect(parseTheme("<script>")).toBe("system");
    expect(parseTheme("system")).toBe("system");
  });

  it("keeps an explicit light or dark choice", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("sets data-theme only for an explicit choice, so system follows the OS in CSS", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("system")).toBeUndefined();
  });

  it("builds a one-year cookie, Secure only when asked", () => {
    expect(themeCookie("dark", false)).toBe(
      `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    expect(themeCookie("light", true)).toMatch(/; Secure$/);
  });
});
