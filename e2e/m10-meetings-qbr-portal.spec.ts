import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";
import { E2E_RECORDINGS } from "../playwright.config";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace, runScript } from "./support/m4";

const WS = "larkspur-demo";

test.describe("M10 Meetings, QBR, Success Plans, Portal & Surveys", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Today shows Brightwell meeting at 14:00 with brief ready", async ({ page }) => {
    await inWorkspace(WS, async (tx, ws) => {
      await tx.todayItem.deleteMany({ where: { workspaceId: ws } });
    });
    await signIn(page, "leo@larkspur.test");
    await page.goto("/today");

    const meetingsSection = page.getByTestId("today-MEETING");
    await expect(meetingsSection).toBeVisible();
    await expect(meetingsSection.getByText(/Brightwell Logistics sync/i)).toBeVisible();
    await expect(meetingsSection.getByText(/brief ready/i)).toBeVisible();
  });

  test("New QBR: a refused period creates nothing; a valid one generates a real QBR and lands on it", async ({
    page,
  }) => {
    // M12 Session C (C0a): the page calls the real generateQbr. The narrative comes from the
    // Meeting & QBR agent on the recorded transport (scripts/recorded-qbr.ts writes the answer the
    // app server replays); the metrics are computed from the account's records.
    const account = "Lumen Freightworks";
    runScript(
      "scripts/recorded-qbr.ts",
      ["--workspace", WS, "--account", account, "--period", "Q3 2026"],
      {
        AI_RECORDINGS_DIR: E2E_RECORDINGS,
      },
    );
    const qbrs = () =>
      inWorkspace(WS, async (tx, ws) => {
        const a = await tx.account.findFirstOrThrow({ where: { workspaceId: ws, name: account } });
        return tx.document.findMany({ where: { workspaceId: ws, accountId: a.id, kind: "QBR" } });
      });
    const before = (await qbrs()).length;

    await signIn(page, "leo@larkspur.test");
    await page.goto("/meetings/qbr/new");
    await expect(
      page.getByRole("heading", { name: "Generate Executive Business Review (QBR)" }),
    ).toBeVisible();
    await page.getByTestId("qbr-account-select").selectOption({ label: account });

    await page.getByTestId("qbr-period-input").fill("next quarter");
    await page.getByRole("button", { name: "Generate QBR" }).click();
    await expect(page.getByRole("form", { name: "New QBR" }).getByRole("alert")).toContainText(
      "Nothing was created",
    );
    expect((await qbrs()).length).toBe(before);

    await page.getByTestId("qbr-period-input").fill("Q3 2026");
    await page.getByRole("button", { name: "Generate QBR" }).click();
    await expect(page).toHaveURL(/\/meetings\/qbr\/(?!new$)[^/]+$/, { timeout: 30_000 });

    const created = await qbrs();
    expect(created.length).toBe(before + 1);
    const doc = created.find((d) => page.url().endsWith(`/meetings/qbr/${d.id}`))!;
    expect(doc).toBeTruthy();
    expect(doc.origin).toBe("AI");
    expect(doc.lockedAt).toBeNull();
    expect((doc.metrics as { period?: string }).period).toBe("Q3 2026");
    const run = await inWorkspace(WS, (tx) =>
      tx.agentRun.findUniqueOrThrow({ where: { id: doc.agentRunId! } }),
    );
    expect(run.agentKey).toBe("meeting-qbr");
    expect(run.status).toBe("SUCCEEDED");

    await expect(page.getByRole("heading", { name: doc.title, level: 1 })).toBeVisible();
    await expect(page.getByTestId("qbr-status")).toHaveText("Draft, not shared with the customer");
    await expect(page.getByTestId("qbr-metrics").getByRole("row")).toHaveCount(9);
    await expect(
      page.getByTestId("qbr-metrics").getByRole("link", { name: "Health tab" }),
    ).toBeVisible();
    await expect(page.getByTestId("qbr-narrative")).toContainText(
      `A review of ${account} for the period`,
    );
    await expectNoBlockingViolations(page);
  });

  test("Account 360 Plans tab renders Brightwell success plan and goals", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");

    const brightwell = await inWorkspace(WS, (tx, ws) =>
      tx.account.findFirstOrThrow({ where: { workspaceId: ws, name: "Brightwell Logistics" } }),
    );

    await page.goto(`/accounts/${brightwell.id}/plans`);
    await expect(page.getByTestId("account-plans")).toBeVisible();
    await expect(page.getByText("Q4 Value Delivery & Executive Alignment")).toBeVisible();
    await expect(page.getByTestId("portal-sharing-badge")).toContainText(
      "Shared with customer portal",
    );
    await expect(page.getByTestId("goals-list")).toBeVisible();
    await expect(page.getByText("Invite finance team to executive review")).toBeVisible();
  });

  test("Settings › Surveys shows active NPS survey and recent detractor response", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/settings/surveys");

    await expect(page.getByRole("heading", { name: "Customer Surveys" })).toBeVisible();
    await expect(page.getByText("NPS Survey")).toBeVisible();
    await expect(page.getByTestId("responses-list")).toBeVisible();
    await expect(page.getByText("Score: 4")).toBeVisible();
    await expect(page.getByText(/Product functionality is solid/i)).toBeVisible();
  });

  test("Portal route denies invalid token with an honest error state", async ({ page }) => {
    await page.goto("/portal/invalid-token-sequence-12345678901234567890");
    await expect(page.getByTestId("portal-auth-error")).toBeVisible();
    await expect(page.getByText(/invalid/i)).toBeVisible();
  });
});
