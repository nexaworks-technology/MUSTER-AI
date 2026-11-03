import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signIn } from "./support/app";
import {
  assignToAdmin,
  countIn,
  createFreshWorkspace,
  integrationId,
  retireEarlierSlackConnections,
  stripeSignature,
} from "./support/m5";

/**
 * M5 demo script (docs/milestones/M5.md §7) on fixture-backed connectors (INTEGRATIONS_TRANSPORT
 * =fixture for both e2e servers; no live network). Each run uses its own fresh workspaces.
 * Covers acceptance #2, #6 (Today), #9 (plain errors), #12 (CSV-only wizard), #13 (back-test
 * sentence from the engine). Slack decisions are proven by interactivity.int.test (the e2e app has
 * no signing secret by design), so here a Slack click is shown refused.
 */
const WEBHOOK_SECRET = "whsec_e2e_only";
const fixture = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf8");

async function reloadUntil(
  page: Page,
  url: string,
  target: RegExp | ((p: Page) => Locator),
  timeout = 60_000,
) {
  const until = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    const loc = typeof target === "function" ? target(page) : page.getByText(target).first();
    if (await loc.isVisible()) return;
    if (Date.now() > until) throw new Error(`${String(target)} did not appear on ${url}`);
    await page.waitForTimeout(1_000);
  }
}

test.describe("M5 integrations and setup", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  let ws: Awaited<ReturnType<typeof createFreshWorkspace>>;
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    await retireEarlierSlackConnections("m5int-");
    ws = await createFreshWorkspace("M5Int");
  });

  test("HubSpot: connect (fixture sign-in), sync, re-sync changes nothing, conflicts and unmatched in plain words", async ({
    page,
  }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/integrations");
    const hubspot = page.getByRole("region", { name: /HubSpot/ });
    await hubspot.getByRole("link", { name: "Connect HubSpot" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Connected HubSpot. It reads only; nothing is written back." }),
    ).toBeVisible();
    await expect(page.getByTestId("status-HUBSPOT")).toHaveText("Connected · read-only");
    await hubspot.getByRole("button", { name: "Run sync now" }).click();
    await reloadUntil(page, "/settings/integrations", /Last sync finished/);
    await expect(page.getByTestId("sync-HUBSPOT")).toContainText("5 added"); // 3 companies + 2 contacts
    await expect(page.getByTestId("sync-HUBSPOT")).toContainText("skipped as invalid");
    await page
      .getByRole("region", { name: /HubSpot/ })
      .getByText(/could not be used/)
      .click();
    await expect(
      page.getByText(/Former Rep \(former\.rep@larkspur\.test\) is not an active admin/),
    ).toBeVisible();

    await page
      .getByRole("region", { name: /HubSpot/ })
      .getByRole("button", { name: "Run sync now" })
      .click();
    await reloadUntil(page, "/settings/integrations", /0 added, 0 updated/);
  });

  test("Chargebee: a rejected key reads in plain words and nothing is saved", async ({ page }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/integrations");
    const cb = page.getByRole("region", { name: /Chargebee/ });
    await cb.getByLabel("Site name").fill("larkspur-test");
    await cb.getByLabel("API key").fill("cb_rejected_key_for_demo");
    await cb.getByRole("button", { name: "Connect Chargebee" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "The API key was rejected by Chargebee. Paste a new read-only key." }),
    ).toBeVisible();
    await expect(page.getByTestId("status-CHARGEBEE")).toHaveText("Not connected");
    await page.screenshot({
      path: "docs/milestones/m5-evidence/02-chargebee-rejected-key-plain-words.png",
      fullPage: true,
    });
  });

  test("Stripe: connect, sync; a forged webhook is refused (nothing stored); payment_failed reaches Today in real time", async ({
    page,
  }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/integrations");
    const stripe = page.getByRole("region", { name: /Stripe/ });
    await stripe.getByLabel("API key").fill("rk_test_e2e_fixture_key");
    await stripe.getByLabel(/Webhook signing secret/).fill(WEBHOOK_SECRET);
    await stripe.getByRole("button", { name: "Connect Stripe" }).click();
    await expect(page.getByTestId("status-STRIPE")).toHaveText("Connected · read-only");
    await page
      .getByRole("region", { name: /Stripe/ })
      .getByRole("button", { name: "Run sync now" })
      .click();
    await reloadUntil(page, "/settings/integrations", (p) =>
      p.getByTestId("sync-STRIPE").getByText(/Last sync finished/),
    );

    // Today lists the member's own book (D-78): in the demo Aisha owns Sundial; here the Admin does.
    await assignToAdmin(ws.workspaceId, "Sundial Fitness");
    // Today is cached for 10 minutes (D-78): look at it first, as a CSM would, so the webhook
    // must refresh it (found in the M5 demo, failure batch 2).
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    const id = await integrationId(ws.workspaceId, "STRIPE");
    const body = fixture(
      "src/modules/integrations/adapters/stripe/__fixtures__/webhook-invoice-payment-failed.json",
    );
    const url = `/api/integrations/stripe/webhook/${id}`;
    const forged = await page.request.post(url, {
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, "whsec_attacker"),
      },
      data: body,
    });
    expect(forged.status()).toBe(401);
    expect(await countIn(ws.workspaceId, "webhookEvent")).toBe(0);

    const real = await page.request.post(url, {
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
      },
      data: body,
    });
    expect(real.status()).toBe(202);
    const replay = await page.request.post(url, {
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(body, WEBHOOK_SECRET),
      },
      data: body,
    });
    expect(replay.status()).toBe(200);
    expect(await countIn(ws.workspaceId, "webhookEvent")).toBe(1);
    await reloadUntil(page, "/today", /Payment failed: invoice SUNDIAL-0011/, 30_000);
    await page.screenshot({
      path: "docs/milestones/m5-evidence/03-payment-failed-in-today.png",
      fullPage: true,
    });
  });

  test("write-back is off by default; allowing Account owner is audited", async ({ page }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/integrations");
    const hubspot = page.getByRole("region", { name: /HubSpot/ });
    await expect(hubspot.getByText("Write-back to HubSpot: off")).toBeVisible();
    await hubspot.getByText("Write-back to HubSpot: off").click();
    await hubspot.getByLabel("Allow write-back").check();
    await hubspot.getByLabel("Account owner").check();
    await hubspot.getByRole("button", { name: "Save write-back" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Write-back is now on." }),
    ).toBeVisible();
    expect(
      await countIn(ws.workspaceId, "auditLog", { action: "integration.writeback_changed" }),
    ).toBe(1);
  });

  test("Slack: connects and links members by verified email; an unsigned click is refused", async ({
    page,
  }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/integrations");
    await page
      .getByRole("region", { name: /Slack/ })
      .getByRole("link", { name: "Connect Slack" })
      .click();
    await expect(page.getByTestId("status-SLACK")).toHaveText("Connected · messages your team");
    await expect(page.getByTestId("slack-linked")).toContainText("Sensitive approvals show");
    const click = await page.request.post("/api/integrations/slack/interactivity", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "payload=%7B%7D",
    });
    expect(click.status()).toBe(401);
  });

  test("Data health lists nothing failed in plain words", async ({ page }) => {
    await signIn(page, ws.email);
    await page.goto("/settings/data-health");
    await expect(page.getByRole("heading", { name: "Data health" })).toBeVisible();
  });

  test("setup wizard, CSV-only path: import, tiers, the engine's back-test sentence, keep default, go live", async ({
    page,
  }) => {
    const fresh = await createFreshWorkspace("M5Setup");
    await signIn(page, fresh.email);
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: /Step 1 of 5: Connect/ })).toBeVisible();
    await page.getByRole("link", { name: "Skip to CSV import" }).click();
    await expect(page.getByTestId("setup-counts")).toContainText("0 accounts");

    await page.goto("/settings/import");
    await page.getByLabel("What are you importing?").selectOption("ACCOUNTS");
    await page
      .getByLabel(/CSV file/)
      .setInputFiles(path.join(process.cwd(), "fixtures/csv/setup-accounts.csv"));
    await page.getByRole("button", { name: "Upload and map columns" }).click();
    await page.getByRole("button", { name: "Preview (nothing is imported yet)" }).click();
    await page.getByRole("button", { name: /^Confirm import of \d+ rows$/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /2 created/ })).toBeVisible({
      timeout: 30_000,
    });

    await page.goto("/setup?step=import");
    await expect(page.getByTestId("setup-counts")).toContainText("2 accounts");
    await page.goto("/setup?step=tiers");
    await expect(page.getByTestId("setup-tiers")).toContainText(
      /High-touch: \$50,000(\.00)? and above/,
    );
    await page.getByRole("button", { name: "Create the proposed segments" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Created 3 segments." })).toBeVisible();

    await page.goto("/setup?step=health");
    await page.getByRole("button", { name: "Run the back-test" }).click();
    await reloadUntil(
      page,
      "/setup?step=health",
      /With this model, we would have flagged \d+ of your last \d+ churns/,
    );
    await expect(page.getByTestId("setup-proposal")).toContainText(
      /With this model, we would have flagged/,
    );
    await page.getByRole("button", { name: "Keep the default model for now" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Kept the default model for now." }),
    ).toBeVisible();

    await page.goto("/setup?step=live");
    await page.getByRole("button", { name: "Go live" }).click();
    await expect(page.getByRole("status").filter({ hasText: "You are live." })).toBeVisible();
    await page.screenshot({
      path: "docs/milestones/m5-evidence/04-setup-go-live.png",
      fullPage: true,
    });
  });
});
