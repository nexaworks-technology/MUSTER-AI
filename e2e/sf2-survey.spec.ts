import { expect, test } from "@playwright/test";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";
import { createSurveyToken } from "../src/modules/surveys/service";

const WS = "larkspur-demo";

test.describe("SF-2 Survey Intake Real-Route Submission and Single-Use Enforcement", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("open /s/[token], render form, submit through UI, verify response stored and token cannot be reused", async ({
    page,
  }) => {
    const { token, surveyId, accountId } = await inWorkspace(WS, async (tx, wsId) => {
      const account = await tx.account.findFirstOrThrow({
        where: { workspaceId: wsId, name: "Brightwell Logistics" },
      });
      const contact = await tx.contact.findFirstOrThrow({
        where: { workspaceId: wsId, accountId: account.id },
      });
      const survey = await tx.survey.findFirstOrThrow({
        where: { workspaceId: wsId, status: "ACTIVE" },
      });

      // Clean up any prior responses from this account/contact for this survey so test is idempotent
      await tx.surveyResponse.deleteMany({
        where: { workspaceId: wsId, surveyId: survey.id, accountId: account.id },
      });

      const token = createSurveyToken({
        workspaceId: wsId,
        surveyId: survey.id,
        accountId: account.id,
        contactId: contact.id,
      });

      return {
        token,
        surveyId: survey.id,
        accountId: account.id,
        question: survey.question,
      };
    });

    // 1. Visit valid survey URL
    await page.goto(`/s/${token}`);

    // 2. Assert page and question render cleanly
    await expect(page.getByTestId("survey-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your feedback" })).toBeVisible();

    // 3. Fill in score and feedback
    // Click score "9"
    await page.locator("label").filter({ hasText: /^9$/ }).click();

    const commentText = "The platform has dramatically streamlined our quarterly reviews and customer insights.";
    await page.locator('textarea[name="comment"]').fill(commentText);

    // 4. Submit form through the UI
    await page.getByRole("button", { name: "Send" }).click();

    // 5. Assert successful submission message is rendered
    await expect(page.getByText("Thank you — your answer was recorded.")).toBeVisible();

    // 6. Assert response is persisted in the database
    const stored = await inWorkspace(WS, async (tx, wsId) => {
      return tx.surveyResponse.findFirst({
        where: {
          workspaceId: wsId,
          surveyId,
          accountId,
          score: 9,
        },
      });
    });
    expect(stored).not.toBeNull();
    expect(stored?.comment).toBe(commentText);

    // 7. Verify token cannot be reused: revisit the same survey URL
    await page.goto(`/s/${token}`);
    await expect(
      page.getByText("This survey has already been answered. Thank you."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).not.toBeVisible();

    // Verify accessibility on the already-answered state
    await expectNoBlockingViolations(page);
  });
});
