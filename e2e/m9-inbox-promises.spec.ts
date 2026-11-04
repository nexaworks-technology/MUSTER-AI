import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

/**
 * M9: Inbox, Unmatched queue, Promise Tracker, Champion Guard, Sentiment & themes, and the Promise
 * Late play, on the seeded Larkspur Analytics workspace (the real Watcher read the story records
 * from recorded answers when the seed ran). No AI is configured in the app under test, so a
 * "draft" click gets the honest "AI is not switched on" answer and sends nothing.
 */
test.describe("M9 Conversations, Inbox, Promises & Sentiment", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Inbox and Promises are in the navigation; a CSM sees only their book", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Promises" })).toBeVisible();
    await page.goto("/inbox?status=ALL");
    await expect(page.getByRole("link", { name: "Halden Retail" }).first()).toBeVisible();
    // Quillmark is Aisha's account: not in Leo's book.
    await expect(page.getByText("Quillmark Legal")).toHaveCount(0);
  });

  test("Inbox: Halden's angry email shows intent, tone and the highlighted quote, linked to its three CSV tickets", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/inbox?status=ALL");
    const row = page.getByTestId("inbox-item").filter({ hasText: "CSV export failed again" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Intent: complaint")).toBeVisible();
    await expect(row.getByTestId("labels").getByText("Sentiment: negative")).toBeVisible();
    await expect(row.getByTestId("labels").getByText("We are losing patience.")).toBeVisible();
    await expect(row.getByTestId("labels").getByText("Complaint: csv export")).toBeVisible();
    await expect(row.getByTestId("related-tickets")).toContainText(
      "Same problem in 3 other tickets",
    );
    await expect(row.getByTestId("sensitive")).toContainText("Always goes to a human");
    // The bounce notice is not a conversation to answer.
    await expect(page.getByText("Undeliverable")).toHaveCount(0);
  });

  test("Inbox: Quillmark's cancel-and-export ticket is sensitive with no auto option, and a draft click sends nothing", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/inbox?status=ALL");
    const row = page.getByTestId("inbox-item").filter({ hasText: "Exporting our data" });
    await expect(row.getByTestId("sensitive")).toContainText("Sensitive");
    await expect(row.getByText("No auto-send option, ever.")).toBeVisible();
    // Earlier specs in the same run may have sent messages; what matters is that this click sent none.
    const count = () =>
      inWorkspace(WS, (tx, ws) => tx.outboundMessage.count({ where: { workspaceId: ws } }));
    const before = await count();
    await row.getByTestId("draft-reply").click();
    await expect(page.getByTestId("draft-note")).toContainText("AI is not switched on");
    expect(await count()).toBe(before);
  });

  test("Unmatched: an email nobody could place waits, and placing it is audited and leaves the queue", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    const subject = `E2E: pricing question ${Date.now()}`;
    await inWorkspace(WS, (tx, ws) =>
      tx.unmatchedInbound.create({
        data: {
          workspaceId: ws,
          provider: "GMAIL",
          externalId: `e2e-unmatched-${Date.now()}`,
          fromAddress: "pat@stranger-co.test",
          toAddresses: ["leo@larkspur.test"],
          subject,
          bodyText: "How much for fifty seats?",
          receivedAt: new Date("2026-11-02T10:00:00Z"),
          reason: "No contact or account uses stranger-co.test.",
          candidateAccountIds: [],
        },
      }),
    );
    await page.goto("/inbox");
    await page.getByRole("link", { name: /^Unmatched \(/ }).click();
    const item = page.getByTestId("unmatched-item").filter({ hasText: subject });
    await expect(item).toContainText("No contact or account uses stranger-co.test.");
    await item.getByLabel("Place on account").selectOption({ label: "Halden Retail" });
    await item.getByRole("button", { name: "Place" }).click();
    await expect(page.getByRole("status")).toContainText("Placed on the account.");
    await expect(page.getByTestId("unmatched-item").filter({ hasText: subject })).toHaveCount(0);
    const audit = await inWorkspace(WS, (tx, ws) =>
      tx.auditLog.count({ where: { workspaceId: ws, action: "inbox.unmatched_assigned" } }),
    );
    expect(audit).toBeGreaterThanOrEqual(1);
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-item").filter({ hasText: subject })).toBeVisible();
  });

  test("Promises: Halden's is late first, with its quote and a link to the call; Northgate's late promise is there too", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/promises");
    const rows = page.getByTestId("promise-row");
    await expect(rows.first().getByTestId("promise-status")).toHaveText("Late");
    const halden = rows.filter({ hasText: "CSV export fix" });
    await expect(halden).toContainText("9 days late");
    await expect(halden).toContainText(
      "Engineering will have the CSV export fix to you by October 24.",
    );
    await expect(halden.getByRole("link", { name: "open the call" })).toBeVisible();
    await expect(rows.filter({ hasText: "API limit increase live" })).toContainText("3 days late");
    await expect(rows.filter({ hasText: "native Zendesk integration" })).toContainText(
      "Not clear from the text",
    );
  });

  test("Promises: add one by hand, give it an owner, mark it kept with a note", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    const promiseName = `Send the E2E onboarding guide ${Date.now()}`;
    await page.goto("/promises");
    await page.getByText("Add a promise by hand").click();
    await page.getByLabel("Account").selectOption({ label: "Halden Retail" });
    await page.getByLabel("What was promised").fill(promiseName);
    await page.getByLabel(/Due date/).fill("2026-10-30");
    await page.getByRole("button", { name: "Add promise" }).click();
    await expect(page.getByRole("status")).toContainText("Promise added.");
    const row = page.getByTestId("promise-row").filter({ hasText: promiseName });
    await expect(row.getByTestId("promise-status")).toHaveText("Late");
    await expect(row).toContainText("Entered by hand.");
    await row
      .getByLabel("How it was kept (saved as a note)")
      .fill("Sent on the 31st, Elena confirmed");
    await row.getByRole("button", { name: "Mark kept" }).click();
    await expect(page.getByRole("status")).toContainText("Marked kept");
    await expect(page.getByTestId("promise-row").filter({ hasText: promiseName })).toHaveCount(0);
    await page.goto("/promises?status=ALL");
    await expect(
      page
        .getByTestId("promise-row")
        .filter({ hasText: promiseName })
        .getByTestId("promise-status"),
    ).toHaveText("Kept");
  });

  test("Account 360: Halden's Promises tab, and Conversations with labels, quotes and the tone panel", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/accounts");
    await page.getByRole("link", { name: "Halden Retail" }).first().click();
    await page
      .getByRole("navigation", { name: "Account sections" })
      .getByRole("link", { name: "Promises", exact: true })
      .click();
    await expect(
      page.getByTestId("promise-row").filter({ hasText: "CSV export fix" }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Account sections" })
      .getByRole("link", { name: "Conversations", exact: true })
      .click();
    await expect(page.getByTestId("tone-panel")).toBeVisible();
    await page.getByTestId("tone-panel").getByText("Tone and themes for this account").click();
    await expect(page.getByTestId("tone-panel").getByTestId("theme").first()).toContainText(
      "csv export",
    );
    await page.getByText("CSV export failed again").first().click();
    await expect(page.getByTestId("labels").getByText("Sentiment: negative").first()).toBeVisible();
  });

  test("Champion Guard: Brightwell's champion bounced; the card names the next contacts with their reasons", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/accounts");
    await page.getByRole("link", { name: "Brightwell Logistics" }).first().click();
    await page
      .getByRole("navigation", { name: "Account sections" })
      .getByRole("link", { name: "People", exact: true })
      .click();
    const card = page.getByTestId("champion-guard");
    await expect(card).toContainText("Maya Ortiz");
    await expect(card).toContainText(/bounced/);
    await expect(card.getByTestId("guard-candidate").first()).toBeVisible();
    await card.getByTestId("draft-intro").first().click();
    await expect(page.getByTestId("intro-note")).toContainText("AI is not switched on");
  });

  test("Sentiment & themes: the CSV export theme shows its quotes with links; clicking it lists them all", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/health");
    await page.getByTestId("sentiment-link").click();
    await expect(page.getByRole("heading", { name: "Sentiment & themes" })).toBeVisible();
    await expect(page.getByTestId("mix")).toBeVisible();
    for (const t of await page.getByTestId("theme").all())
      await expect(t.getByTestId("theme-quote").first()).toBeVisible();
    await page.getByTestId("themes").getByRole("link", { name: "csv export" }).click();
    await expect(page).toHaveURL(/theme=csv_export/);
    const quotes = page.getByTestId("theme-quote");
    expect(await quotes.count()).toBeGreaterThanOrEqual(4);
    await expect(quotes.first().getByRole("link", { name: "open the source" })).toBeVisible();
    await quotes.first().getByRole("link", { name: "open the source" }).click();
    await expect(page).toHaveURL(/\/accounts\/[^/]+\/(tickets|conversations)/);
  });

  test("Plays: Promise Late is live on its detector and publishes when a person says so", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/plays");
    await page.getByRole("link", { name: "Promise Late" }).click();
    await expect(page.getByRole("heading", { name: "Promise Late" })).toBeVisible();
    await page.getByRole("button", { name: "Publish Play" }).click();
    await expect(page.getByText(/Published/i).first()).toBeVisible();
  });
});
