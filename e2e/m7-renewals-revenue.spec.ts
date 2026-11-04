import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";
import { inWorkspace } from "./support/m4";
import { prepareM7, recordRenewalOutcome } from "./support/m7";

/**
 * M7 demo script, Session A part (docs/milestones/M7.md), against the seeded `_test` database
 * frozen at SEED_TODAY (2026-11-02). Per D-120 (corrected): Northgate Freight is one of seven
 * renewals tied at the lowest confidence (70%) in the next 90 days. The test asserts that tie
 * group and Northgate's membership and reasons, and nothing stronger; the LOW-band story arrives
 * with M9/M10 data. Session B adds the brief, approval, expansion and outcome steps. Agent runs come
 * from the RECORDED transport (see e2e/support/m7.ts); the e2e is re-seeded, never reset, so the
 * steps make their own rows.
 */
const WS = "larkspur-demo";
const NONCE = `e2e-${Date.now()}`;
const TIE = [
  "Aspenwood Fitness",
  "Harborbrook Solicitors",
  "Meridianhaven Consulting",
  "Larkwood Works",
  "Northgate Freight",
  "Harborwood Accounting",
  "Beaconcrest Transport",
];

test.describe("M7 renewals and revenue", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    const out = prepareM7(WS, NONCE);
    expect(out).toContain("AI transport: RECORDED");
    expect(out).toContain("renewal-manager Northgate: SUCCEEDED");
    expect(out).toContain("expansion-finder Copperleaf: SUCCEEDED");
  });

  test("Dana's radar: the seven-way tie at 70%, Northgate among them, with its reasons and ARR", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Renewals" })
      .click();
    await expect(page.getByRole("heading", { name: "Renewals", exact: true })).toBeVisible();
    await expect(page.getByTestId("forecast")).toBeVisible();
    for (const name of TIE)
      await expect(page.getByTestId(`renewal-row-${name}`).getByTestId("confidence")).toHaveText(
        "70%",
      );
    const northgate = page.getByTestId("renewal-row-Northgate Freight");
    await expect(northgate).toContainText("Dec 13, 2026");
    await expect(northgate).toContainText("$142,000");
    await northgate.locator("summary", { hasText: "Why 70%" }).click();
    await expect(northgate).toContainText("Health (+10 points): Health is Healthy");
    await expect(northgate).toContainText("Notice deadline (-10 points)");
    // Nothing else is listed lower than the tie.
    const all = await page.getByTestId("confidence").allTextContents();
    expect(Math.min(...all.map((t) => Number(t.replace("%", ""))))).toBe(70);
  });

  test("A person's forecast category sits beside the computed band; a difference is flagged; clearing it works", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/renewals");
    const row = page.getByTestId("renewal-row-Northgate Freight");
    await row.locator("summary", { hasText: "Change" }).click();
    await row.getByLabel("Forecast category").selectOption("AT_RISK");
    await row.getByLabel("Note").fill("Champion wavering");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toContainText("Forecast category saved.");
    const after = page.getByTestId("renewal-row-Northgate Freight");
    await expect(after.getByTestId("forecast-disagreement")).toContainText("suggests Commit");
    await expect(after.getByTestId("confidence")).toHaveText("70%");
    await after.locator("summary", { hasText: "Change" }).click();
    await after.getByLabel("Forecast category").selectOption("");
    await after.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toContainText("Forecast category cleared.");
  });

  test("Leo (no revenue access): the radar shows no money and no forecast, Revenue is not in the nav and is a 404", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/renewals");
    await expect(page.getByRole("heading", { name: "Renewals", exact: true })).toBeVisible();
    await expect(page.getByTestId("forecast")).toHaveCount(0);
    await expect(page.locator("tbody tr").first()).toContainText("Restricted");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Revenue" }),
    ).toHaveCount(0);
    const res = await page.goto("/revenue");
    expect(res?.status()).toBe(404);
  });

  test("Dana's Revenue screen: a reconciled waterfall, money at risk, expected billing, coverage and team load", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Revenue" })
      .click();
    await expect(page.getByRole("heading", { name: "Revenue", exact: true })).toBeVisible();
    const wf = page.getByTestId("waterfall-USD");
    await expect(wf).toContainText("Opening ARR");
    await expect(wf).toContainText("Closing ARR");
    await expect(wf).toContainText("Opening plus movements equals closing");
    await expect(page.getByTestId("at-risk-30")).toBeVisible();
    await expect(page.getByTestId("at-risk-90")).toBeVisible();
    await expect(page.getByTestId("coverage")).toContainText(
      "accounts had contact in the last 30 days",
    );
    await expect(page.getByRole("heading", { name: "Team load" })).toBeVisible();
  });

  test("Northgate's renewal brief: locked figures with their sources, and the Renewal Manager's plan with the figures filled in by code", async ({
    page,
  }) => {
    await signIn(page, "dana@larkspur.test");
    await page.goto("/renewals");
    await page
      .getByTestId("renewal-row-Northgate Freight")
      .getByRole("link", { name: "Renewal brief" })
      .click();
    await expect(
      page.getByRole("heading", { name: /Renewal brief: Northgate Freight/ }),
    ).toBeVisible();
    const metrics = page.getByTestId("brief-metrics");
    await expect(metrics.locator('[data-metric="renewal.date"]')).toContainText("Dec 13, 2026");
    await expect(metrics.locator('[data-metric="renewal.daysTo"]')).toContainText("41 days");
    await expect(metrics.locator('[data-metric="renewal.confidence"]')).toContainText("70%");
    await expect(metrics.locator('[data-metric="renewal.arr"]')).toContainText("$142,000.00");
    await expect(metrics.locator('[data-metric="health.band"]')).toContainText("Healthy");
    await expect(metrics.locator('[data-metric="risks.count"]')).toContainText(
      "6 open risk signals",
    );
    await expect(metrics.locator('[data-metric="promises.status"]')).toContainText(
      "1 promise made: 1 late, 0 open, 0 kept",
    );
    await expect(
      metrics
        .locator('[data-metric="health.band"]')
        .getByRole("link", { name: /HealthScoreSnapshot/ }),
    ).toBeVisible();
    const narrative = page.getByTestId("brief-narrative");
    await expect(narrative).toContainText("Renewal plan");
    await expect(narrative).toContainText("Talk track");
    await expect(narrative).toContainText("on Dec 13, 2026 an easy yes");
    await expect(narrative).toContainText("The notice deadline is Nov 13, 2026");
    await expect(narrative).toContainText("Next step: Confirm the renewal call, by 2026-11-09.");
    await expect(narrative).not.toContainText("{{");
    await expect(narrative).toContainText("Written by the Renewal Manager");
  });

  test("Approvals: the Renewal Manager's outreach for Northgate (renewal date only), approve: sent through dispatch; the Task for the next step exists", async ({
    page,
  }) => {
    const pending = await inWorkspace(WS, (tx) =>
      tx.approval.findFirstOrThrow({
        where: { status: "PENDING", proposedByRun: { is: { agentKey: "renewal-manager" } } },
        orderBy: { createdAt: "desc" },
      }),
    );
    await signIn(page, "dana@larkspur.test");
    await page.goto(`/approvals/${pending.id}`);
    await expect(page.getByTestId("approval-level")).toHaveText("Draft for approval");
    await expect(page.getByText(/Renewal outreach for Northgate Freight/).first()).toBeVisible();
    const draft = page.getByTestId("draft");
    await expect(draft).toContainText("Your renewal comes up on Dec 13, 2026.");
    await expect(draft).not.toContainText(/70%|142,000|Healthy|\{\{/);
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByTestId("message-status")).toContainText(
      /sent, sent .*\(log transport\)/,
    );
    const [message, task] = await inWorkspace(WS, (tx) =>
      Promise.all([
        tx.outboundMessage.findFirstOrThrow({ where: { approvalId: pending.id } }),
        tx.task.findFirstOrThrow({
          where: { origin: "AI", title: { startsWith: "Confirm the renewal call" } },
          orderBy: { createdAt: "desc" },
        }),
      ]),
    );
    expect(message).toMatchObject({ status: "SENT", transport: "log", origin: "AI" });
    expect(task.title).toBe("Confirm the renewal call — by 2026-11-09");
    expect(task.dueAt!.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  test("Expansion: Copperleaf's estimate from its own price with the method shown, the Finder's note citing the seat records, and export refused until write-back is turned on", async ({
    page,
    browser,
  }, testInfo) => {
    // HubSpot connected, read-only (the M5 flow; an Admin does it, as the CRM export needs a CRM).
    const adminContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const admin = await adminContext.newPage();
    await signIn(admin, "admin@larkspur.test");
    await admin.goto("/settings/integrations");
    const connect = admin
      .getByRole("region", { name: /HubSpot/ })
      .getByRole("link", { name: "Connect HubSpot" });
    if (await connect.count()) {
      await connect.click();
      await expect(admin.getByTestId("status-HUBSPOT")).toHaveText("Connected · read-only");
    }
    await adminContext.close();
    await signIn(page, "dana@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Expansion" })
      .click();
    await expect(page.getByRole("heading", { name: "Expansion", exact: true })).toBeVisible();
    const card = page.getByTestId("opportunity-Copperleaf Studios");
    await expect(card.getByTestId("estimate")).toHaveText(
      "Estimate: $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription)",
    );
    await expect(card).toContainText("52 of 40 seats in use");
    await expect(card).toContainText("Usage grew to");
    const note = card.getByTestId("finder-note");
    await expect(note).toContainText(
      "52 people used the product in the last 28 days on a contract for 40 seats",
    );
    await expect(note).toContainText(
      "an estimate of $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription)",
    );
    await expect(note).not.toContainText("{{");
    await card.locator("summary", { hasText: "Whitespace" }).click();
    await expect(card.getByTestId("seat-headroom")).toContainText("12 seats over the limit");
    await expect(card.getByTestId("whitespace")).not.toContainText("$");
    await page
      .getByTestId("opportunity-Copperleaf Studios")
      .getByRole("button", { name: "Export to HubSpot" })
      .click();
    await expect(page.locator('p[role="alert"]')).toContainText(
      "Turn on write-back for HubSpot to sync.",
    );
  });

  test("Leo (no revenue access): the Expansion page and the brief show no money; the estimate reads Restricted", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/expansion");
    await expect(page.getByRole("heading", { name: "Expansion", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/\$10,800|\$900|1080000/);
    for (const t of await page.getByTestId("estimate").allTextContents())
      expect(t).toBe("Estimate: Restricted");
    await page.goto("/renewals");
    const row = page.locator('[data-testid^="renewal-row-"]').first();
    await row.getByRole("link", { name: "Renewal brief" }).click();
    await expect(page.getByRole("heading", { name: /Renewal brief:/ })).toBeVisible();
    const build = page.getByRole("button", { name: "Build the brief" });
    if (await build.count()) await build.click();
    await expect(page.locator('[data-metric="renewal.arr"]')).toContainText("Restricted");
    await expect(page.locator("main")).not.toContainText(/\$[\d,]+\.\d\d/);
  });

  test("An outcome recorded through the contract records, with the forecast frozen as it stood", async ({
    page,
  }) => {
    // A renewal well outside the 90-day radar window, so the tie group the first test asserts is
    // untouched on a re-run of the suite (a recorded outcome is append-only and stays).
    const account = "Oakcrest Couriers";
    const out = recordRenewalOutcome(WS, account);
    expect(out).toMatch(
      new RegExp(
        `${account}: (renewal on 2027-02-09 recorded as RENEWED.*forecast frozen at \\d+% \\((?:HIGH|MEDIUM|LOW)\\)|an outcome is already recorded)`,
      ),
    );
    await signIn(page, "dana@larkspur.test");
    const oakcrest = await inWorkspace(WS, (tx) =>
      tx.account.findFirstOrThrow({ where: { name: account } }),
    );
    await page.goto(`/accounts/${oakcrest.id}/renewal`);
    const past = page.getByTestId("past-renewals");
    await expect(past).toContainText("Feb 9, 2027: Renewed");
    await expect(past).toContainText("from contract records");
    await expect(past).toContainText(
      /The forecast on .+ said \d+% \((?:High|Medium|Low) confidence\)/,
    );
  });
});
