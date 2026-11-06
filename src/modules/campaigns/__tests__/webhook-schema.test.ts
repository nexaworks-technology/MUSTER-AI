import { describe, expect, it } from "vitest";
import { parseEmailWebhookEvent } from "../service";

/**
 * M12 B9 (A9 finding, test-first): a signed email webhook body is still external input, so it is
 * Zod-parsed before use (CLAUDE.md). A malformed body is refused as invalid, never a 500.
 */
describe("email webhook payload", () => {
  it("accepts a provider delivery event with tags as an array or a map", () => {
    const a = parseEmailWebhookEvent({
      type: "email.bounced",
      created_at: "2026-11-06T10:00:00Z",
      data: {
        email_id: "em_1",
        to: ["x@example.com"],
        tags: [{ name: "workspace_id", value: "w1" }],
      },
    });
    expect(a?.data.email_id).toBe("em_1");
    const b = parseEmailWebhookEvent({
      type: "email.delivered",
      data: { id: "em_2", tags: { workspace_id: "w1" } },
    });
    expect(b?.data.id).toBe("em_2");
  });

  it("refuses bodies that are not delivery events", () => {
    for (const bad of [
      null,
      "text",
      [],
      { type: "email.bounced" },
      { type: 7, data: {} },
      { type: "email.bounced", data: "x" },
      { type: "email.bounced", data: { email_id: 5 } },
      { type: "email.bounced", data: { tags: [{ name: "workspace_id" }] } },
      { type: "email.bounced", data: { workspace_id: { $ne: null } } },
    ])
      expect(parseEmailWebhookEvent(bad), JSON.stringify(bad)).toBeNull();
  });
});
