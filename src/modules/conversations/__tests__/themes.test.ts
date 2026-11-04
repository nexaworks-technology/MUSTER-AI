import { describe, expect, it } from "vitest";
import { DEFAULT_THEMES, groupableTheme, themeSettingSchema } from "../themes";

describe("themes (D5): a fixed list, `other` never groups", () => {
  it("the default list names CSV export, API limits and `other`", () => {
    expect(DEFAULT_THEMES).toEqual(expect.arrayContaining(["csv_export", "api_limits", "other"]));
  });
  it("a theme on the list groups; `other` and unknown labels do not", () => {
    expect(groupableTheme("csv_export", DEFAULT_THEMES)).toBe("csv_export");
    expect(groupableTheme("  CSV_Export ", DEFAULT_THEMES)).toBe("csv_export");
    expect(groupableTheme("other", DEFAULT_THEMES)).toBeNull();
    expect(groupableTheme("the export thing", DEFAULT_THEMES)).toBeNull();
  });
  it("the audited setting must keep `other` and have no duplicates", () => {
    expect(themeSettingSchema.safeParse(["billing", "other"]).success).toBe(true);
    expect(themeSettingSchema.safeParse(["billing"]).success).toBe(false);
    expect(themeSettingSchema.safeParse(["billing", "billing", "other"]).success).toBe(false);
    expect(themeSettingSchema.safeParse(["Bad Key", "other"]).success).toBe(false);
  });
});
