import { expect, test } from "@playwright/test";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";
import { createUnsubscribeToken } from "../src/modules/campaigns/unsubscribe";

const WS = "larkspur-demo";

test.describe("SF-3 Unsubscribe Real-Route Execution and Recipient State Transition", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("invalid or missing token displays honest refusal state", async ({ page }) => {
    // 1. Missing token
    await page.goto("/unsubscribe");
    await expect(page.getByRole("heading", { name: "Email Preferences" })).toBeVisible();
    await expect(
      page.getByText("No unsubscribe token provided. If you followed a link, please check the URL."),
    ).toBeVisible();

    // 2. Tampered or invalid token
    await page.goto("/unsubscribe?token=malformed-signature-token-12345");
    await expect(
      page.getByText(/invalid or (has )?expired/i),
    ).toBeVisible();

    await expectNoBlockingViolations(page);
  });

  test("valid signed token performs unsubscribe, updates recipient state to HELD, and records suppression", async ({
    page,
  }) => {
    const testEmail = "unsub.qa.contact@brightwell-logistics.test";

    const { token, recipientId } = await inWorkspace(WS, async (tx, wsId) => {
      const account = await tx.account.findFirstOrThrow({
        where: { workspaceId: wsId, name: "Brightwell Logistics" },
      });

      // Find or create a designated contact for this unsubscribe verification
      let contact = await tx.contact.findFirst({
        where: {
          workspaceId: wsId,
          email: testEmail,
        },
      });
      if (!contact) {
        contact = await tx.contact.create({
          data: {
            workspaceId: wsId,
            accountId: account.id,
            email: testEmail,
            name: "Unsubscribe QA Tester",
          },
        });
      }

      // Clear any prior suppression for test idempotency
      await tx.emailSuppression.deleteMany({
        where: { workspaceId: wsId, email: testEmail },
      });

      // Ensure an existing campaign to associate recipient
      let campaign = await tx.campaign.findFirst({
        where: { workspaceId: wsId },
      });
      if (!campaign) {
        let segment = await tx.segment.findFirst({ where: { workspaceId: wsId } });
        if (!segment) {
          segment = await tx.segment.create({
            data: {
              workspaceId: wsId,
              name: "QA Unsubscribe Segment",
              filter: {},
            },
          });
        }
        campaign = await tx.campaign.create({
          data: {
            workspaceId: wsId,
            name: "QA Unsubscribe Campaign",
            segmentId: segment.id,
            subject: "Product Updates",
            body: "Hello, this is an update email.",
          },
        });
      }

      // Clean up prior recipients for this contact & create a fresh QUEUED recipient
      await tx.campaignRecipient.deleteMany({
        where: { workspaceId: wsId, contactId: contact.id },
      });

      const recipient = await tx.campaignRecipient.create({
        data: {
          workspaceId: wsId,
          campaignId: campaign.id,
          accountId: account.id,
          contactId: contact.id,
          status: "QUEUED",
        },
      });

      const token = createUnsubscribeToken({
        workspaceId: wsId,
        contactId: contact.id,
        email: testEmail,
      });

      return {
        token,
        recipientId: recipient.id,
        contactId: contact.id,
      };
    });

    // Visit unsubscribe URL with the valid signed token
    await page.goto(`/unsubscribe?token=${token}`);

    // Verify UI feedback
    await expect(page.getByRole("heading", { name: "Email Preferences" })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`You have been unsubscribed \\(${testEmail}\\)`, "i")),
    ).toBeVisible();

    // Verify recipient state transition in the database
    const recipient = await inWorkspace(WS, async (tx, _wsId) => {
      return tx.campaignRecipient.findUnique({
        where: { id: recipientId },
      });
    });
    expect(recipient?.status).toBe("HELD");
    expect(recipient?.heldReason).toContain("unsubscribed");
    expect(recipient?.unsubscribedAt).not.toBeNull();

    // Verify suppression record in the database
    const suppression = await inWorkspace(WS, async (tx, wsId) => {
      return tx.emailSuppression.findUnique({
        where: {
          workspaceId_email: {
            workspaceId: wsId,
            email: testEmail,
          },
        },
      });
    });
    expect(suppression?.reason).toBe("UNSUBSCRIBED");

    await expectNoBlockingViolations(page);
  });
});
