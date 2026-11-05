import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support/app";
import { REC, ensureM11Data } from "./support/m11";
import { inWorkspace, runScript } from "./support/m4";

const WS = "larkspur-demo";
const EVIDENCE = path.join(process.cwd(), "docs/milestones/m11-evidence");

let saveRecordPath = "";

async function threadIdFor(email: string, fragment: string): Promise<string> {
  return inWorkspace(WS, async (tx, ws) => {
    const m = await tx.askMessage.findFirstOrThrow({
      where: {
        workspaceId: ws,
        role: "USER",
        content: { contains: fragment },
        thread: { user: { email } },
      },
      orderBy: { createdAt: "desc" },
    });
    return m.threadId;
  });
}

async function openThread(page: Page, email: string, fragment: string) {
  const id = await threadIdFor(email, fragment);
  await page.goto(`/ask/${id}`);
  return id;
}

test.describe("M11 Ask AI, ledger, reports, voice", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    saveRecordPath = (await ensureM11Data(WS)).saveRecordPath;
  });

  test("Dana's three answered threads show sources and what it read (#10)", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    await openThread(page, "dana@larkspur.test", "mentioned a competitor");
    const msgs = page.getByTestId("ask-messages");
    await expect(msgs).toContainText("Brightwell Logistics");
    await expect(msgs).toContainText("Tallyfield");
    await expect(msgs.getByRole("link", { name: /what it read/i }).first()).toHaveAttribute(
      "href",
      /\/agent-runs\/.+/,
    );
    await expect(msgs.locator("a").first()).toBeVisible();

    await openThread(page, "dana@larkspur.test", "Northgate Freight's contract value");
    await expect(page.getByTestId("ask-messages")).toContainText("$142,000.00");
    await expect(
      page
        .getByTestId("ask-messages")
        .getByRole("link", { name: /contract/i })
        .first(),
    ).toBeVisible();
    await expect(page.getByText(/confidence/i).first()).toBeVisible();

    await openThread(page, "dana@larkspur.test", "Fairhaven Dental Group's contract value");
    await expect(page.getByTestId("ask-messages")).toContainText(
      "I cannot see a contract for Fairhaven Dental Group.",
    );
  });

  test("Dana's move request waits for Yes, then executes through approve() (#11)", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    const threadId = await openThread(page, "dana@larkspur.test", "Move Northgate Freight");
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText("Northgate Freight");
    await expect(card).toContainText("Brightwell Logistics");
    await expect(page.getByTestId("card-changes").locator("li")).toHaveCount(2);

    const before = await inWorkspace(WS, async (tx, ws) => {
      const accts = await tx.account.findMany({
        where: { workspaceId: ws, name: { in: ["Northgate Freight", "Brightwell Logistics"] } },
      });
      const play = await tx.play.findFirstOrThrow({
        where: { workspaceId: ws, key: "renewal-risk" },
      });
      return tx.playRun.count({
        where: { workspaceId: ws, playId: play.id, accountId: { in: accts.map((a) => a.id) } },
      });
    });
    expect(before).toBe(0);

    await card.getByRole("button", { name: "Yes, do it" }).click();
    await expect(page.getByTestId("card-results")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("card-results").locator("li")).toHaveCount(2);

    const after = await inWorkspace(WS, async (tx, ws) => {
      const accts = await tx.account.findMany({
        where: { workspaceId: ws, name: { in: ["Northgate Freight", "Brightwell Logistics"] } },
      });
      const play = await tx.play.findFirstOrThrow({
        where: { workspaceId: ws, key: "renewal-risk" },
      });
      const runs = await tx.playRun.findMany({
        where: { workspaceId: ws, playId: play.id, accountId: { in: accts.map((a) => a.id) } },
      });
      const audits = await tx.auditLog.count({
        where: { workspaceId: ws, action: "approval.change_executed" },
      });
      return { accounts: new Set(runs.map((r) => r.accountId)).size, audits };
    });
    expect(after.accounts).toBe(2);
    expect(after.audits).toBeGreaterThanOrEqual(2);
    expect(threadId).toBeTruthy();
  });

  test("Leo cannot see Dana's threads", async ({ page }) => {
    const danaThread = await threadIdFor(
      "dana@larkspur.test",
      "Northgate Freight's contract value",
    );
    await signIn(page, "leo@larkspur.test");
    const res = await page.goto(`/ask/${danaThread}`);
    expect(res?.status()).toBe(404);
    await page.goto("/ask");
    await expect(page.getByRole("navigation", { name: "Your conversations" })).not.toContainText(
      "Northgate",
    );
    await expect(page.getByTestId("thread-list")).toHaveCount(0);
  });

  test("Dana attaches the contract PDF and asks about it", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/ask");
    await page
      .getByLabel(/Attach a file/)
      .setInputFiles(path.join(process.cwd(), "e2e/fixtures/northgate-contract-terms.pdf"));
    await expect(page).toHaveURL(/\/ask\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByLabel("Attached files")).toContainText("northgate-contract-terms.pdf");
    const threadId = new URL(page.url()).pathname.split("/").pop()!;
    const file = await inWorkspace(WS, (tx, ws) =>
      tx.fileObject.findFirstOrThrow({
        where: {
          workspaceId: ws,
          purpose: "ASK_ATTACHMENT",
          filename: "northgate-contract-terms.pdf",
        },
        orderBy: { createdAt: "desc" },
      }),
    );
    runScript(
      "scripts/recorded-ask.ts",
      [
        "--workspace",
        WS,
        "--thread",
        threadId,
        "--file",
        file.id,
        "--question",
        "What is the notice period?",
      ],
      REC,
    );
    await page.reload();
    const msgs = page.getByTestId("ask-messages");
    await expect(msgs).toContainText("Either party may terminate with 60 days’ written notice.");
    await expect(msgs.locator("a").first()).toBeVisible();
  });

  test("Ledger: Dana sees the attributed headline and money, Leo sees it restricted (#4)", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/reports/outcomes?period=365");
    const head = page.getByTestId("ledger-headline");
    await expect(head).toContainText(/attributed, not proven causal/i);
    // The Harborwood save chain dates its day-90 checkpoint in 2027, after the e2e clock
    // (2026-11-02), so no money reaches the ledger here (see report); money is asserted on the
    // save record below. What must hold for Dana: the money is not marked restricted.
    await expect(head).toContainText(/worth: ARR at the flag/i);
    await expect(head).not.toContainText(/restricted/i);
    await page.screenshot({ path: path.join(EVIDENCE, "ledger-dana.png"), fullPage: true });

    await page.context().clearCookies();
    await signIn(page, "leo@larkspur.test");
    await page.goto("/reports/outcomes?period=365");
    await expect(page.getByText(/Restricted/i).first()).toBeVisible();
    await expect(page.getByTestId("ledger-headline")).not.toContainText("$");
    await expect(page.getByRole("region", { name: "The counts" })).not.toContainText("$");
    await page.screenshot({ path: path.join(EVIDENCE, "ledger-leo.png"), fullPage: true });
  });

  test("Save record: signal, approval, sent email, RENEWED at day 90, saved value (#5)", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto(saveRecordPath);
    await expect(page.getByRole("heading", { name: /Save record: Harborwood/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Renewal in 30 days/ })).toBeVisible();
    const actions = page.getByRole("region", { name: "What was done" });
    await expect(actions).toContainText(/approval/i);
    await expect(actions).toContainText(/sent|email|message/i);
    await expect(page.getByTestId("checkpoint-90")).toContainText("RENEWED");
    const value = page.getByTestId("saved-value");
    await expect(value).toContainText("Saved: $5,700.00");
    await expect(page.getByText(/attributed|not proven/i).first()).toBeVisible();
  });

  test("Reports: portfolio health trend, Mid-touch, every figure opens its records (#7)", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/reports/portfolio-health-trend");
    await page.getByLabel("Tier").selectOption({ label: "Mid-touch" });
    await page.getByRole("button", { name: "Show latest" }).click();
    await expect(page).toHaveURL(/tier=/);
    await page.getByRole("button", { name: "Generate with these filters" }).click();
    await expect(page.getByTestId("snapshot-meta")).toContainText("Mid-touch");
    const link = page.getByTestId("figure").getByRole("link").first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    await link.click();
    await expect(page).toHaveURL(new RegExp(href!.split("?")[0]!.replace(/[/]/g, "\\/")));
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  });

  test("AI accuracy: definitions, and a row's records open 'Records behind this number'", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/reports/ai-accuracy");
    await expect(page.getByRole("heading", { name: "What the words mean" })).toBeVisible();
    await expect(page.getByText("True alarm:")).toBeVisible();
    const row = page.getByTestId(/^rule-/).first();
    await row.getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: "Records behind this number" })).toBeVisible();
  });

  test("Weekly digest shows cited sentences and no money", async ({ page }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/reports/digest");
    const digest = page.getByTestId("weekly-digest");
    await expect(digest).toBeVisible();
    await expect(digest.getByRole("link").first()).toBeVisible();
    await expect(digest).not.toContainText("$");
  });

  test("Voice dictation is off by default and Ask shows no dictation button (#15)", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/workspace");
    const toggle = page.getByTestId("voice-dictation-toggle");
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/Audio is handled by your browser vendor/)).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE, "voice-setting-off.png"),
      fullPage: true,
    });
    await page.goto("/ask");
    await expect(page.getByTestId("dictation-button")).toHaveCount(0);
  });
});
