import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { resetMissingDataPrompts } from "./support/db";

/**
 * M2 demo script (docs/milestones/M2.md §7) against the seeded `_test` database. The database
 * is re-seeded but never reset between runs (D-36), so every assertion holds on a re-run too.
 * Runs once (desktop); the a11y spec covers both viewports.
 */
const account = (key: string) => `/accounts/${seedId(`account:${key}`)}`;
const fixture = (...p: string[]) => path.join(process.cwd(), ...p);

async function importCsv(page: Page, kind: string, file: string) {
  await page.goto("/settings/import");
  await page.getByLabel("What are you importing?").selectOption(kind);
  await page.getByLabel(/CSV file/).setInputFiles(file);
  await page.getByRole("button", { name: "Upload and map columns" }).click();
  await expect(page).toHaveURL(/\/settings\/import\/[^/]+$/);
  await page.getByRole("button", { name: "Preview (nothing is imported yet)" }).click();
}

async function confirmAndWait(page: Page) {
  await page.getByRole("button", { name: /^Confirm import of \d+ rows$/ }).click();
  const result = page.getByRole("status").filter({ hasText: /\d+ created, \d+ updated/ });
  await expect(result).toBeVisible({ timeout: 30_000 });
  return (await result.textContent()) ?? "";
}

test.describe("M2 accounts and Account 360", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Priya browses accounts and Brightwell's Account 360", async ({ page }) => {
    await signIn(page, "admin@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Accounts" })
      .click();
    await expect(page.getByRole("columnheader", { name: /ARR/ })).toBeVisible();
    await page.getByLabel("Search").fill("Brightwell");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("link", { name: "Brightwell Logistics" }).click();
    await expect(page.getByRole("heading", { name: "Brightwell Logistics" })).toBeVisible();
    for (const tab of ["People", "Usage", "Tickets", "Contracts & billing", "Timeline"]) {
      await page.getByRole("link", { name: tab, exact: true }).click();
      await expect(page.getByRole("link", { name: tab, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
    await page.getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByTestId("person-Maya Ortiz")).toBeVisible();
  });

  test("Tom (Viewer) sees Restricted instead of money and no edit controls", async ({ page }) => {
    await signIn(page, "tom@larkspur.test");
    await page.goto("/accounts");
    await expect(page.getByText("Restricted").first()).toBeVisible();
    await expect(page.getByLabel(/^Tier for /)).toHaveCount(0);
    await page.goto(`${account("brightwell")}/billing`);
    await expect(page.getByText("Restricted").first()).toBeVisible();
    await expect(page.getByText(/\$\d/)).toHaveCount(0);
  });

  test("Leo sees his own book only", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/accounts?q=Brightwell");
    await expect(page.getByRole("link", { name: "Brightwell Logistics" })).toBeVisible();
    await page.goto("/accounts?q=Pinecrest");
    await expect(page.getByRole("link", { name: "Pinecrest Health" })).toHaveCount(0);
    const res = await page.goto(account("pinecrest"));
    expect(res?.status()).toBe(404);
  });

  test("missing data: Leo answers Kestrel's renewal date; Priya skips Bluefin's owner", async ({
    browser,
  }) => {
    await resetMissingDataPrompts("larkspur-demo");
    const leo = await browser.newPage();
    await signIn(leo, "leo@larkspur.test");
    await leo.goto(account("kestrel"));
    const card = leo.getByRole("form", { name: "Missing information" });
    await expect(card.getByText("When does this contract renew?")).toBeVisible();
    await card.getByLabel("When does this contract renew?").fill("2027-04-01");
    await card.getByRole("button", { name: "Answer" }).click();
    // Answered: the question goes away and does not come back.
    await expect(leo.getByRole("form", { name: "Missing information" })).toHaveCount(0);
    await leo.reload();
    await expect(leo.getByRole("form", { name: "Missing information" })).toHaveCount(0);
    await leo.goto(`${account("kestrel")}/billing`);
    await expect(leo.getByText("Apr 1, 2027").first()).toBeVisible();
    await leo.close();

    const priya = await browser.newPage();
    await signIn(priya, "admin@larkspur.test");
    await priya.goto(account("bluefin"));
    const ask = priya.getByRole("form", { name: "Missing information" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: /^Skip for 7 days$/ }).click();
    await expect(priya.getByRole("form", { name: "Missing information" })).toHaveCount(0);
    await priya.reload();
    await expect(priya.getByRole("form", { name: "Missing information" })).toHaveCount(0);
    await priya.close();
  });

  test("CSV import: plain-words error, fixed file imports, re-import creates nothing", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await importCsv(page, "CONTACTS", fixture("docs/samples/contacts-sample.csv"));
    await expect(page.getByRole("list", { name: "Rows with problems" })).toContainText(/Row 4/);

    await importCsv(page, "CONTACTS", fixture("fixtures/csv/contacts-sample-fixed.csv"));
    await expect(page.getByRole("list", { name: "Rows with problems" })).toHaveCount(0);
    expect(await confirmAndWait(page)).toMatch(/0 failed/);

    await importCsv(page, "CONTACTS", fixture("fixtures/csv/contacts-sample-fixed.csv"));
    expect(await confirmAndWait(page)).toMatch(/^0 created, 0 updated, 3 unchanged, 0 failed/);
  });

  test("an imported account with no usage shows an empty state, not placeholder data", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await importCsv(page, "ACCOUNTS", fixture("fixtures/csv/accounts-clean.csv"));
    await confirmAndWait(page);
    await page.goto("/accounts?q=Foxglove");
    await page.getByRole("link", { name: "Foxglove Freight" }).click();
    await page.getByRole("link", { name: "Usage", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No usage data yet" })).toBeVisible();
    // No chart drawn from made-up rows (Rule 6).
    await expect(page.getByRole("main").getByRole("img")).toHaveCount(0);
  });

  test("data quality: Silverline duplicates merge only after Confirm", async ({ page }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/data-quality");
    await page.getByRole("button", { name: "Run scan" }).click();
    await expect(page.getByText(/Scan finished/)).toBeVisible();
    await expect(page.getByText(/2 contact records for Ken Ward/).first()).toBeVisible();
    await page.getByRole("link", { name: /^Preview all \d+ safe fixes$/ }).click();
    const review = page.getByRole("region", { name: /^Review \d+ fix/ });
    await expect(review).toContainText("Keep Ken Ward");
    // Previewing changed nothing yet.
    await page.goto(`${account("silverline")}/people`);
    await expect(page.getByTestId("person-Amy  Stone")).toBeVisible();
    await page.goBack();
    await review.getByRole("button", { name: /^Confirm (all \d+ fixes|fix)$/ }).click();
    await expect(page.getByText(/^\d+ fixed\.$/)).toBeVisible();
    await page.goto(`${account("silverline")}/people`);
    await expect(page.getByTestId("person-Amy  Stone")).toHaveCount(0);
  });

  test("a CSM cannot reach Settings › Data quality or Import", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    expect((await page.goto("/settings/data-quality"))?.status()).toBe(404);
    expect((await page.goto("/settings/import"))?.status()).toBe(404);
  });

  test("segment, task and @mention", async ({ page, browser }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/accounts?tier=LONG_TAIL&stage=ADOPTING");
    const name = `Long-tail adopting ${Date.now()}`;
    await page.getByLabel("Save these filters as a segment").fill(name);
    await page.getByRole("button", { name: "Save segment" }).click();
    await expect(page.getByLabel("Segment").getByRole("option", { name })).toHaveCount(1);

    await page.goto(`${account("pinecrest")}/tasks`);
    const title = `Book QBR ${Date.now()}`;
    await page.getByLabel("Task", { exact: true }).fill(title);
    await page.getByLabel("Owner").selectOption({ label: "Aisha Bello" });
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText(title)).toBeVisible();

    await page.goto(`${account("pinecrest")}/notes`);
    await page.getByLabel("Note", { exact: true }).fill("@Aisha Bello can you own the QBR?");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("can you own the QBR?").first()).toBeVisible();

    const aisha = await browser.newPage();
    await signIn(aisha, "aisha@larkspur.test");
    await expect(aisha.getByRole("link", { name: /^Notifications, \d+ unread$/ })).toBeVisible();
    await aisha.close();
  });

  test("files: authorised download works; another workspace's download is refused", async ({
    page,
    browser,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto(`${account("brightwell")}/billing`);
    await page.getByLabel(/^Signed contract/).setInputFiles({
      name: "brightwell-msa.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Master services agreement (e2e fixture)\n"),
    });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const link = page.getByRole("link", { name: /brightwell-msa\.txt/ }).first();
    await expect(link).toBeVisible();
    const href = (await link.getAttribute("href"))!;
    expect(href).toMatch(/^\/api\/files\/[^/]+\/download$/);

    const own = await page.request.get(href);
    expect(own.status()).toBe(200);
    expect(own.headers()["content-disposition"]).toMatch(/^attachment/);

    const other = await browser.newPage();
    await signIn(other, "admin@ferngrove.test");
    const refused = await other.request.get(href);
    expect(refused.status()).toBe(404);
    await other.close();
  });
});
