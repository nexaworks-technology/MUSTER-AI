import { describe, expect, it } from "vitest";
import { fieldSourceLabel, sourceLabel } from "../providers";

/**
 * DEMO-WALKTHROUGH FAIL 51/53: where a value came from was recorded (`source`, `fieldSources`) but
 * shown only on Billing and in Data quality. One wording everywhere, from the stored source only.
 */
describe("source labels", () => {
  it("names connectors and says plainly when a person, a CSV or the system set it", () => {
    expect(sourceLabel("HUBSPOT")).toBe("from HubSpot");
    expect(sourceLabel("ZENDESK")).toBe("from Zendesk");
    expect(sourceLabel("GMAIL")).toBe("from Gmail");
    expect(sourceLabel("GOOGLE_CALENDAR")).toBe("from Google Calendar");
    expect(sourceLabel("MIXPANEL")).toBe("from Mixpanel");
    expect(sourceLabel("MANUAL")).toBe("entered by a person");
    expect(sourceLabel("CSV")).toBe("from a CSV import");
    expect(sourceLabel("SEED")).toBe("from the demo data");
  });

  it("a field's own source wins over the record's; an unknown source is not guessed", () => {
    expect(fieldSourceLabel({ industry: "SALESFORCE" }, "HUBSPOT", "industry")).toBe(
      "from Salesforce",
    );
    expect(fieldSourceLabel({}, "HUBSPOT", "industry")).toBe("from HubSpot");
    expect(fieldSourceLabel(null, "HUBSPOT", "industry")).toBe("from HubSpot");
    expect(fieldSourceLabel({ industry: "SOMETHING_NEW" }, "HUBSPOT", "industry")).toBeNull();
  });
});
