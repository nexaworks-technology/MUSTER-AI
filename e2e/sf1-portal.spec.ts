import { expect, test } from "@playwright/test";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";
import { createPortalAccess } from "../src/modules/portal/service";

const WS = "larkspur-demo";

test.describe("SF-1 Customer Portal Valid & Invalid Token Access", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("open /portal/[token] with a VALID token: renders active portal with live plans", async ({
    page,
  }) => {
    const { rawToken, accountName, contactName } = await inWorkspace(WS, async (tx, wsId) => {
      const account = await tx.account.findFirstOrThrow({
        where: { workspaceId: wsId, name: "Brightwell Logistics" },
      });
      const contact = await tx.contact.findFirstOrThrow({
        where: { workspaceId: wsId, accountId: account.id },
      });

      const { rawToken } = await createPortalAccess(
        { workspaceId: wsId },
        {
          accountId: account.id,
          contactId: contact.id,
        },
      );

      return {
        rawToken,
        accountName: account.name,
        contactName: contact.name,
      };
    });

    await page.goto(`/portal/${rawToken}`);

    // Verify container and header
    await expect(page.getByTestId("portal-container")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `${accountName} Portal` }),
    ).toBeVisible();
    await expect(page.getByText(`Welcome back, ${contactName}`)).toBeVisible();

    // Verify shared success plan
    const planCard = page.getByTestId("portal-plan");
    await expect(planCard).toBeVisible();
    await expect(planCard.getByText("Q4 Value Delivery & Executive Alignment")).toBeVisible();
    await expect(planCard.getByText("ACTIVE")).toBeVisible();

    // Verify accessibility on the active portal view
    await expectNoBlockingViolations(page);
  });

  test("open /portal/[token] with an INVALID token: shows honest error state", async ({
    page,
  }) => {
    await page.goto("/portal/invalid-token-sequence-12345678901234567890");
    await expect(page.getByTestId("portal-auth-error")).toBeVisible();
    await expect(page.getByText(/invalid/i)).toBeVisible();
  });
});
