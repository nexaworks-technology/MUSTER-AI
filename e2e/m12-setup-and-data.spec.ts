import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { rawDb } from "../src/lib/db/raw";
import { E2E_QUEUE_PREFIX } from "../playwright.config";
import { signIn } from "./support/app";
import { inWorkspace, runScript } from "./support/m4";
import { createFreshWorkspace } from "./support/m5";

/**
 * M12 B8 — the M12 demo script (M12.md §7) on the PRODUCTION build (D-182), steps 1–3 and 5–9:
 * a fresh workspace goes through the setup wizard (CSV + Stripe test-mode fixtures) to a day-1
 * Today; Priya exports Larkspur (ZIP link + audit row); the fresh workspace's Admin requests
 * deletion with the typed name, sees the grace and 30-day timeline, and after the grace (fast-
 * forwarded by the dev-only demo script) is purged while Larkspur is untouched; Tom (Viewer) is
 * read-only with money Restricted; Pilot metrics show a CSM's opens with their records.
 * Step 1's "sign up" is a fresh workspace + Admin made directly: the product has no self sign-up.
 */
const WS = "larkspur-demo";
const AS_OF = "2026-11-02"; // the e2e business clock (playwright.config E2E_FAKE_CLOCK)

async function reloadUntil(
  page: Page,
  url: string,
  target: (p: Page) => Locator,
  timeout = 90_000,
) {
  const until = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    if (await target(page).isVisible()) return;
    if (Date.now() > until) throw new Error(`target did not appear on ${url}`);
    await page.waitForTimeout(1_000);
  }
}

test.describe("M12 demo: setup to day 1, data controls, viewer, pilot metrics", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  let pilot: Awaited<ReturnType<typeof createFreshWorkspace>>;
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    pilot = await createFreshWorkspace("PilotDemo");
  });

  test("steps 1–3: setup wizard with CSV + Stripe test mode, go live, a real day-1 Today", async ({
    page,
  }) => {
    await signIn(page, pilot.email);
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: /Step 1 of 6: Connect/ })).toBeVisible();

    // Stripe in test mode (recorded fixtures, INTEGRATIONS_TRANSPORT=fixture).
    await page.goto("/settings/integrations");
    const stripe = page.getByRole("region", { name: /Stripe/ });
    await stripe.getByLabel("API key").fill("rk_test_e2e_fixture_key");
    await stripe.getByLabel(/Webhook signing secret/).fill("whsec_e2e_only");
    await stripe.getByRole("button", { name: "Connect Stripe" }).click();
    await expect(page.getByTestId("status-STRIPE")).toHaveText("Connected · read-only");
    await stripe.getByRole("button", { name: "Run sync now" }).click();
    await reloadUntil(page, "/settings/integrations", (p) =>
      p.getByTestId("sync-STRIPE").getByText(/Last sync finished/),
    );

    // The pilot's CSVs: accounts with their owner (the import maps owner_email; without owners
    // nobody's Today lists them, D-78) and one contract renewing inside 90 days.
    const dir = path.join(process.cwd(), "test-results", "m12-setup");
    mkdirSync(dir, { recursive: true });
    const accountsCsv = path.join(dir, "pilot-accounts.csv");
    writeFileSync(
      accountsCsv,
      [
        "account_id,name,tier,domain,stage,owner_email,plan,industry,employee_band",
        `PD-1,Bramble Robotics,Mid-touch,bramble-robotics.test,Adopting,${pilot.email},Growth,Manufacturing,51-200`,
        `PD-2,Quillon Health,High-touch,quillon-health.test,Adopting,${pilot.email},Enterprise,Healthcare,201-500`,
        "PD-3,Larchmont Legal,Long-tail,larchmont-legal.test,Onboarding,,Starter,Legal,1-50",
      ].join("\n"),
    );
    const contractsCsv = path.join(dir, "pilot-contracts.csv");
    writeFileSync(
      contractsCsv,
      [
        "contract_id,account_id,account_domain,start_date,end_date,renewal_date,value,currency,seats,notice_days,auto_renew,status",
        "PDK-1,PD-2,,2025-12-15,2026-12-15,2026-12-15,72000.00,USD,80,60,no,Active",
        "PDK-2,PD-1,,2026-06-01,2027-06-01,2027-06-01,18000.00,USD,20,60,no,Active",
      ].join("\n"),
    );
    for (const [kind, file] of [
      ["ACCOUNTS", accountsCsv],
      ["CONTRACTS", contractsCsv],
    ] as const) {
      await page.goto("/settings/import");
      await page.getByLabel("What are you importing?").selectOption(kind);
      await page.getByLabel(/CSV file/).setInputFiles(file);
      await page.getByRole("button", { name: "Upload and map columns" }).click();
      await page.getByRole("button", { name: "Preview (nothing is imported yet)" }).click();
      await page.getByRole("button", { name: /^Confirm import of \d+ rows$/ }).click();
      await expect(page.getByRole("status").filter({ hasText: /\d+ created/ })).toBeVisible({
        timeout: 30_000,
      });
    }

    await page.goto("/setup?step=import");
    await expect(page.getByTestId("setup-counts")).not.toContainText(/^0 accounts/);

    await page.goto("/setup?step=tiers");
    await expect(page.getByTestId("setup-tiers")).toContainText(/High-touch/);
    await page.getByRole("button", { name: "Create the proposed segments" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /Created \d+ segments\./ }),
    ).toBeVisible();

    await page.goto("/setup?step=health");
    await page.getByRole("button", { name: "Run the back-test" }).click();
    await reloadUntil(page, "/setup?step=health", (p) =>
      p.getByText(/With this model, we would have flagged \d+ of your last \d+ churns/).first(),
    );
    await page.getByRole("button", { name: "Keep the default model for now" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Kept the default model for now." }),
    ).toBeVisible();

    await page.goto("/setup?step=plays");
    await expect(page.getByRole("heading", { name: /Proposed plays/ })).toBeVisible();
    const createDrafts = page.getByRole("button", { name: "Create Proposed Play Drafts" });
    if (await createDrafts.count()) await createDrafts.click();

    await page.goto("/setup?step=live");
    await page.getByRole("button", { name: "Go live" }).click();
    await expect(page.getByRole("status").filter({ hasText: "You are live." })).toBeVisible();

    // The nightly run through the real queue (demo step 4's command), then day 1.
    const nightly = runScript(
      "scripts/jobs-nightly.ts",
      ["--workspace", pilot.slug, "--as-of", AS_OF],
      {
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
      },
    );
    expect(nightly).toMatch(/health|signals/i);
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    // Built from the imported data: the owned account renewing in 43 days, nothing from the demo.
    const renewals = page.getByRole("region", { name: /Renewals in the next 90 days/ });
    await expect(renewals).toContainText("Quillon Health");
    await expect(page.locator("main")).not.toContainText("Larchmont Legal"); // unowned
    await expect(page.locator("main")).not.toContainText("Northgate Freight");
  });

  test("step 5: Priya exports Larkspur — the ZIP link works and the audit row exists", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/data");
    // Q-19: the AI provider's data terms, stated only as far as verified (docs/SECURITY.md).
    await expect(page.getByRole("region", { name: "AI processing" })).toContainText(
      "may not train models on customer content",
    );
    await expect(page.getByRole("region", { name: "AI processing" })).toContainText(
      "not yet confirmed",
    );
    await page.getByTestId("export-all-data").click();
    await reloadUntil(page, "/settings/data", (p) =>
      p.getByRole("link", { name: "Download ZIP" }).first(),
    );
    const href = await page
      .getByRole("link", { name: "Download ZIP" })
      .first()
      .getAttribute("href");
    const zip = await page.request.get(href!);
    expect(zip.status()).toBe(200);
    expect((await zip.body()).subarray(0, 2).toString("latin1")).toBe("PK");
    const audit = await inWorkspace(WS, (tx) =>
      tx.auditLog.count({
        where: { action: { in: ["data.export_requested", "data.export_ready"] } },
      }),
    );
    expect(audit).toBeGreaterThanOrEqual(2);
  });

  test("steps 6–7: typed deletion request, grace + 30-day timeline, purge; Larkspur untouched", async ({
    page,
  }) => {
    await signIn(page, pilot.email);
    await page.goto("/settings/data");
    await expect(page.getByText(/deleted within 30 days of your request/)).toBeVisible();
    await page.getByTestId("confirm-workspace-name").fill("not the name");
    await page.getByTestId("delete-workspace").click();
    await expect(page.getByText(/type the workspace name/i)).toBeVisible();
    const ws = await rawDb.workspace.findUniqueOrThrow({ where: { id: pilot.workspaceId } });
    await page.getByTestId("confirm-workspace-name").fill(ws.name);
    await page.getByTestId("delete-workspace").click();
    await expect(page.getByTestId("deletion-pending")).toContainText(/unless you cancel/);

    const larkspurBefore = await inWorkspace(WS, (tx) => tx.account.count());
    const out = runScript("scripts/demo-purge-now.ts", ["--workspace", pilot.slug]);
    expect(out).toContain(`purged ${pilot.slug}`);
    expect(await rawDb.workspace.findUnique({ where: { id: pilot.workspaceId } })).toBeNull();
    const tomb = await rawDb.workspaceTombstone.findUniqueOrThrow({
      where: { workspaceId: pilot.workspaceId },
    });
    expect(tomb.purgedAt).not.toBeNull();
    expect(await inWorkspace(WS, (tx) => tx.account.count())).toBe(larkspurBefore);
  });

  test("step 8: Tom (Viewer) is read-only with money Restricted, and has no Data controls", async ({
    page,
  }) => {
    await signIn(page, "tom@larkspur.test");
    const account = await inWorkspace(WS, (tx) =>
      tx.account.findFirstOrThrow({ where: { name: "Northgate Freight" }, select: { id: true } }),
    );
    await page.goto(`/accounts/${account.id}`);
    await expect(page.getByText("Restricted").first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/\$[\d,]+\.\d\d/);
    await page.goto("/settings/data");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  test("step 9: Pilot metrics show Leo's opens, each figure opening its records", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/today");
    await page.goto("/approvals");
    await page.context().clearCookies();
    await signIn(page, "admin@larkspur.test");
    await page.goto("/reports/pilot-metrics");
    await expect(page.getByRole("heading", { name: "Pilot metrics", level: 1 })).toBeVisible();
    const leo = page.getByTestId("pilot-period").getByRole("row", { name: /Leo Marsh/ });
    await expect(leo).toBeVisible();
    await leo.getByRole("link").first().click();
    await expect(page.locator("#records")).toContainText(/today\.opened|approvals\.opened/);
  });
});
