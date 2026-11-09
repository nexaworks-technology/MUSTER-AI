import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { inWorkspace, prepareM4 } from "./support/m4";

/**
 * M4 demo script (docs/milestones/M4.md §7) against the seeded `_test` database. Agent runs come
 * from the RECORDED transport (fixture answers, no live model; see e2e/support/m4.ts); every send
 * goes through dispatch to the log-only transport. Re-seeded, never reset: steps create their own
 * approvals and assert on those.
 */
const WS = "larkspur-demo";
const account = (key: string) => `/accounts/${seedId(`account:${key}`)}`;

test.describe("M4 Today, approvals and the AI team", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });
  test.beforeAll(({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    const out = prepareM4(WS);
    expect(out).toContain("AI transport: RECORDED");
    expect(out).toContain("health-analyst Brightwell: SUCCEEDED");
    expect(out).toContain("health-analyst Halden (recorded refusal): FAILED");
  });

  test("Leo lands on Today: only his book, ranked, with the reason on every item", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await expect(page).toHaveURL(/\/today$/);
    const tasks = page.getByTestId("today-TASK");
    const halden = tasks
      .getByTestId("today-item")
      .filter({ hasText: "Follow up with Halden on the CSV export fix" });
    await expect(halden).toBeVisible();
    // Leo has no revenue access: the value is not shown, the reason still is.
    await expect(halden.getByTestId("today-reasons")).toHaveText(
      /^Account value × overdue \d+ days$/,
    );
    await expect(
      page.getByTestId("today-SIGNAL").getByText("Usage fell to 58% of normal").first(),
    ).toBeVisible();
    await expect(page.getByTestId("today-MEETING")).toContainText("No calendar connected");
    await expect(page.getByText("Chase SSO setup with Pinecrest IT")).toHaveCount(0); // Aisha's
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Approvals" }),
    ).toBeVisible();
  });

  test("Brightwell's Health tab: the Health Analyst narrative, each item linked to its reason", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto(`${account("brightwell")}/health`);
    const ai = page.getByTestId("ai-text");
    await expect(ai).toBeVisible();
    const items = ai.getByTestId("ai-item");
    expect(await items.count()).toBeGreaterThanOrEqual(1);
    for (const sources of await ai.getByTestId("ai-sources").all())
      expect(await sources.getByRole("link").count()).toBeGreaterThanOrEqual(1);
    await expect(ai).toContainText("model confidence");
    await items.first().getByTestId("ai-sources").getByRole("link").first().click();
    await expect(page).toHaveURL(/\/health\?reason=.+#reason-/);
    await expect(page.locator('[data-testid="health-reason"][aria-current="true"]')).toBeVisible();
    await page.getByTestId("ai-text").getByRole("link", { name: "What it read" }).click();
    await expect(page).toHaveURL(/\/agent-runs\//);
    await expect(page.getByRole("heading", { name: /What it read/ })).toBeVisible();
    await expect(page.getByTestId("run-status")).toHaveAttribute("data-status", "SUCCEEDED");
  });

  test("Draft check-in on the usage drop → edit one sentence → approve: sent through dispatch, flag ACTED", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto(`${account("brightwell")}/signals`);
    const signal = page
      .getByTestId("signal")
      .filter({ hasText: "Usage fell to 58% of normal" })
      .first();
    await signal.getByTestId("draft-check-in").click();
    await expect(page.getByRole("heading", { name: "Draft check-in" })).toBeVisible();
    await expect(page.getByTestId("ai-not-configured")).toBeVisible();
    const stamp = Date.now();
    await page.getByLabel("Subject").fill(`Quick check-in ${stamp}`);
    await page
      .getByLabel("Message")
      .fill("Hi, I noticed your team is using the dashboards less. Want a walkthrough?");
    await page.getByRole("button", { name: "Save draft for approval" }).click();
    await expect(page).toHaveURL(/\/approvals\/(?!new)[^/?]+$/);
    const approvalId = page.url().split("/").pop()!;
    await expect(
      page
        .getByTestId("approval-proof")
        .getByRole("link", { name: /Signal: Usage fell to 58% of normal/ }),
    ).toBeVisible();
    await expect(page.getByTestId("approval-level")).toHaveText("Draft for approval");

    await page.getByRole("button", { name: "Edit before approving" }).click();
    await page
      .getByRole("textbox", { name: "Message" })
      .fill(
        "Hi, I noticed your team is using the dashboards less. Could we look at it together this week?",
      );
    await page.getByRole("button", { name: "Save edit and approve" }).click();
    // The decision controls unmount once decided; the page shows the lasting outcome.
    await expect(page.getByTestId("message-status")).toContainText(
      /sent, sent .*\(log transport\)/,
    );
    await expect(page.getByTestId("approval-status")).toHaveText("edited approved");

    const row = await inWorkspace(WS, (tx) =>
      tx.approval.findUniqueOrThrow({
        where: { id: approvalId },
        include: { outboundMessages: true, revisions: true },
      }),
    );
    expect(row.status).toBe("EDITED_APPROVED");
    expect(row.revisions.map((r) => r.version).sort()).toEqual([1, 2]);
    const msg = row.outboundMessages[0]!;
    expect(msg).toMatchObject({ status: "SENT", transport: "log" });
    expect((msg.guardResults as unknown[]).length).toBe(14);
    expect(msg.bodyText).toContain("Could we look at it together this week?");
    const outcome = await inWorkspace(WS, (tx) =>
      tx.outcomeRecord.findUniqueOrThrow({
        where: { workspaceId_signalId: { workspaceId: row.workspaceId, signalId: row.signalId! } },
      }),
    );
    expect(outcome.actionTaken).toBe("ACTED");
    const sentFile = (
      await inWorkspace(WS, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { targetId: msg.id, action: "outbound.sent" } }),
      )
    ).summary;
    expect(sentFile).toContain("log transport");
  });

  test("Aisha drafts a check-in on Quillmark's export/cancel ticket: Sensitive: cancellation, always human; then rejects it", async ({
    page,
  }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto(`${account("quillmark")}/tickets`);
    const ticket = page.getByTestId("ticket").filter({ hasText: "Exporting our data" });
    await ticket.locator("summary").click();
    await ticket.getByTestId("draft-check-in").click();
    await expect(page.getByText("How do I export all our data before we cancel")).toBeVisible();
    await page.getByLabel("Subject").fill(`About your data export ${Date.now()}`);
    await page
      .getByLabel("Message")
      .fill("Thanks for your note. Could we have a short call this week?");
    await page.getByRole("button", { name: "Save draft for approval" }).click();
    await expect(page.getByTestId("sensitive-banner")).toContainText("Sensitive: cancellation");
    await expect(page.getByTestId("approval-level")).toHaveText(
      "Draft for approval · Always human",
    );

    await page.getByLabel("Why reject it?").fill("Call her instead of emailing");
    await page.getByRole("button", { name: "Reject" }).click();

    await expect(page.getByTestId("approval-status")).toHaveText("rejected");
    await expect(page.getByTestId("message-status")).toContainText("cancelled");
  });

  test("Dana's Today shows Aisha's escalated overdue task", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    const item = page
      .getByTestId("today-TASK")
      .getByTestId("today-item")
      .filter({ hasText: "Chase SSO setup with Pinecrest IT" });
    await expect(item).toBeVisible();
    await expect(item.getByTestId("today-reasons")).toContainText(
      "escalated: Aisha Bello's task, overdue",
    );
  });

  test("AI team: what the Health Analyst read, decided and did; a failed run is shown as failed; no auto-send switch", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/ai-team");
    await expect(page.getByText("Agents never send on their own")).toBeVisible();
    await expect(page.getByRole("button", { name: /auto-send/i })).toHaveCount(0);
    const ha = page.getByTestId("agent-health-analyst");
    await ha
      .locator('[data-testid="agent-run-row"][data-status="SUCCEEDED"]')
      .first()
      .getByRole("link")
      .click();
    await expect(page.getByRole("heading", { name: /What it read/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What it decided" })).toBeVisible();
    await expect(page.getByText(/Model confidence \d+%/)).toBeVisible();
    await expect(page.getByRole("heading", { name: /What it did/ })).toBeVisible();
    await page.goBack();
    await ha
      .locator('[data-testid="agent-run-row"][data-status="FAILED"]')
      .first()
      .getByRole("link")
      .click();
    await expect(page.getByTestId("run-status")).toHaveAttribute("data-status", "FAILED");
    await expect(page.getByTestId("run-status")).toContainText("MODEL_DECLINED");
    await expect(page.getByTestId("run-not-shown")).toBeVisible();
    await expect(page.getByRole("heading", { name: "What it decided" })).toHaveCount(0);
  });

  test("Audit: filter agent runs, approvals and sends; export CSV; the export is itself listed", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/audit?action=agent.run,approval.,outbound.");
    const actions = await page
      .getByTestId("audit-row")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-action")));
    expect(actions.some((a) => a?.startsWith("agent.run"))).toBe(true);
    expect(actions.some((a) => a?.startsWith("approval."))).toBe(true);
    expect(actions.some((a) => a === "outbound.sent")).toBe(true);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-csv").click(),
    ]);
    const csv = await readFile((await download.path())!, "utf8");
    expect(csv.split("\r\n")[0]).toBe(
      "createdAt,actorType,actorId,actor,action,targetType,targetId,agentRunId,summary,before,after",
    );
    await page.goto("/settings/audit?action=audit.exported");
    await expect(page.getByTestId("audit-row").first()).toContainText(
      /Exported \d+ audit row\(s\) as CSV/,
    );
  });
});
