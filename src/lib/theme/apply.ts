import { themeAttribute, themeCookie, type ThemeChoice } from "./index";

/** Browser side of a theme choice: the attribute now, the cookie for the next server render. */
export function applyTheme(next: ThemeChoice): void {
  const root = document.documentElement;
  const attr = themeAttribute(next);
  if (attr) root.setAttribute("data-theme", attr);
  else root.removeAttribute("data-theme");
  document.cookie = themeCookie(next, window.location.protocol === "https:");
}
