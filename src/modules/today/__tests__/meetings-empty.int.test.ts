import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { hasCalendarConnected, meetingsEmptyText } from "../service";

/** DEMO-WALKTHROUGH FAIL 5: the empty Meetings section said "No calendar connected" while one was. */
describe("Today's empty Meetings section", () => {
  it("asks for a calendar only when none is connected", async () => {
    const { actor } = await createTestAdmin("MeetEmpty");
    expect(await hasCalendarConnected(actor)).toBe(false);
    expect(meetingsEmptyText(false)).toMatch(/No calendar connected/);
    const cal = await scopedDb(actor).integration.create({
      data: { workspaceId: actor.workspaceId, provider: "GOOGLE_CALENDAR" },
    });
    expect(await hasCalendarConnected(actor)).toBe(true);
    expect(meetingsEmptyText(true)).toBe("No meetings with your accounts today.");
    await scopedDb(actor).integration.update({
      where: { id: cal.id },
      data: { status: "DISCONNECTED" },
    });
    expect(await hasCalendarConnected(actor)).toBe(false);
  });
});
