import { expect, test, type Page } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { auditActions } from "./support/db";
import { reopenSignal } from "./support/signals";

/**
 * M3 demo script (docs/milestones/M3.md §7) against the seeded `_test` database. Re-seeded, never
 * reset (D-36): the one state a run leaves behind that would change the next (the false alarm) is
 * put back first, and the model test ends by re-activating the default weights as a new version.
 * Bands are asserted as the engine finds them (Q-44, Q-45), never as SEED_DATA hoped.
 */
const account = (key: string) => `/accounts/${seedId(`account:${key}`)}`;
const WS = "larkspur-demo";

async function openPillar(page: Page, pillar: string) {
  const tile = page.getByTestId(`pillar-${pillar}`);
  await tile.locator("summary").click();
  return tile;
}

test.describe("M3 health and signals", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("Leo opens Brightwell's health: every pillar opens into reasons with sources", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Health" })
      .click();
    await expect(page.getByRole("heading", { name: "Health", level: 1 })).toBeVisible();
    await page.getByTestId("band-WATCH").click();
    await page
      .getByTestId("band-accounts")
      .getByRole("link", { name: "Brightwell Logistics" })
      .click();
    await expect(page).toHaveURL(/\/health$/);
    await expect(page.getByTestId("health-overall")).toBeVisible();

    // Adoption: value, baseline, cohort, and a source that opens the usage window highlighted.
    const adoption = await openPillar(page, "ADOPTION");
    await expect(adoption.getByText(/Typical weekday active users fell from 40 to/)).toBeVisible();
    await expect(adoption.getByText(/compared with 9 accounts like this one/)).toBeVisible();
    for (const p of ["ENGAGEMENT", "SUPPORT", "RELATIONSHIP", "COMMERCIAL"]) {
      const tile = await openPillar(page, p);
      const evidence = tile.locator('[data-testid="health-reason"][data-kind="EVIDENCE"]');
      await expect(evidence.first()).toBeVisible();
      for (const r of await evidence.all())
        await expect(
          r.getByRole("list", { name: "Sources" }).getByRole("link").first(),
        ).toBeVisible();
    }
    // Relationship: the champion bounce, linked to the contact.
    const rel = page.getByTestId("pillar-RELATIONSHIP");
    await expect(rel.getByText(/Champion Maya Ortiz: email bounced/)).toBeVisible();
    await expect(rel.getByRole("link", { name: "Contact: Maya Ortiz" })).toHaveAttribute(
      "href",
      /\/people#contact-/,
    );
    // Sentiment: no data, excluded, weight spread over the rest.
    const sentiment = page.getByTestId("pillar-SENTIMENT");
    await expect(sentiment.locator("summary")).toContainText("Not enough data");
    await sentiment.locator("summary").click();
    await expect(sentiment.getByText(/Its 10% weight is spread across the pillars/)).toBeVisible();

    await adoption
      .getByRole("link", { name: /^Usage, Oct 26 – Nov 1, 2026$/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/usage\?from=2026-10-26&to=2026-11-01/);

    // Signals tab: usage drop with evidence and the four spec fields.
    await page.goto(`${account("brightwell")}/signals`);
    const drop = page.getByTestId("signal").filter({ hasText: "Usage fell to 58% of normal" });
    await expect(
      drop.getByRole("list", { name: "Evidence" }).getByRole("link").first(),
    ).toBeVisible();
    await drop.getByText("About this signal").click();
    await expect(drop.getByText("How early it appears")).toBeVisible();
  });

  test("every proof link on Brightwell's Health and Signals tabs lands on the record it names", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    const hrefs = new Set<string>();
    for (const [tab, list] of [
      ["health", "Sources"],
      ["signals", "Evidence"],
    ] as const) {
      await page.goto(`${account("brightwell")}/${tab}`);
      // CSS, not getByRole: reasons sit in closed <details>, which role queries skip.
      for (const a of await page.locator(`[aria-label="${list}"] a`).all()) {
        const href = await a.getAttribute("href");
        if (href?.startsWith("/")) hrefs.add(href);
      }
    }
    expect(hrefs.size).toBeGreaterThan(10);
    for (const href of hrefs) {
      const [path, hash] = href.split("#");
      const res = await page.request.get(path!);
      expect(res.status(), href).toBe(200);
      if (hash) expect(await res.text(), href).toContain(`id="${hash}"`);
    }
  });

  test("Priya sees Sundial's failed payment with the invoice linked", async ({ page }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto(`${account("sundial")}/signals`);
    const s = page.getByTestId("signal").filter({ hasText: "Payment failed: invoice LRK-1075" });
    await expect(s).toContainText("Open");
    await s.getByRole("link", { name: "Invoice LRK-1075" }).click();
    await expect(page).toHaveURL(/\/billing#invoice-/);
  });

  test("Pulse: Tidewater already disagrees; Leo's Worried on a Healthy account joins the list", async ({
    page,
  }) => {
    await signIn(page, "leo@larkspur.test");
    await page.goto("/health");
    const list = page.getByTestId("disagreements");
    await expect(list.getByText(/Leo Marsh says Worried: "New VP is skeptical"/)).toBeVisible();
    await expect(list.getByRole("link", { name: "Tidewater Clinics" })).toBeVisible();

    await page.goto(`${account("marlow-finch")}/health`);
    await page.getByRole("button", { name: "Worried" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved: Worried." })).toBeVisible();
    await expect(page.getByTestId("disagreement-detail")).toContainText(
      "Both are shown; neither replaces the other.",
    );
    await page.goto("/health");
    await expect(
      page.getByTestId("disagreements").getByRole("link", { name: "Marlow & Finch" }),
    ).toBeVisible();
  });

  test("Leo marks a signal as a false alarm and it leaves the open list", async ({ page }) => {
    await reopenSignal(WS, seedId("account:brightwell"), "seats_unused");
    await signIn(page, "leo@larkspur.test");
    await page.goto(`${account("brightwell")}/signals`);
    const s = page.getByTestId("signal").filter({ hasText: "Only 36 of 207 seats in use" });
    await s.getByLabel("Why is it a false alarm?").fill("Seats are pre-bought for a Q1 rollout");
    await s.getByRole("button", { name: /^Mark false alarm:/ }).click();
    // The signal stays on the account, marked, with the reason; its action buttons are gone.
    await expect(s).toContainText("Marked false alarm");
    await expect(s).toContainText("False alarm: Seats are pre-bought for a Q1 rollout");
    await page.goto("/health/signals");
    await expect(
      page.getByTestId("signal").filter({ hasText: "Only 36 of 207 seats in use" }),
    ).toHaveCount(0);
  });

  test("Leo (CSM) cannot reach the signal or health-model settings", async ({ page }) => {
    await signIn(page, "leo@larkspur.test");
    expect((await page.goto("/settings/signals"))?.status()).toBe(404);
    expect((await page.goto("/settings/health-model"))?.status()).toBe(404);
  });

  test("Priya changes a signal threshold; the saved value is what shows after a reload", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/signals");
    const rule = page.getByTestId("rule-ticket_open_too_long");
    const input = rule.getByLabel("Target days: high");
    const original = await input.inputValue();
    for (const value of [String(Number(original) + 1), original]) {
      await input.fill(value);
      await rule.getByRole("button", { name: /^Save / }).click();
      await expect(rule.getByRole("status")).toHaveText("Saved.");
      await page.reload();
      await expect(input).toHaveValue(value);
    }
  });

  test("Priya adds an outside signal for Northgate; it shows on the account, dated", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/signals");
    const form = page.locator("section", {
      has: page.getByRole("heading", { name: "Add an outside signal" }),
    });
    await form.getByLabel("Account").selectOption({ label: "Northgate Freight" });
    await form.getByLabel("Kind").selectOption("LEADERSHIP_CHANGE");
    await form.getByLabel("Headline").fill("New COO appointed");
    await form.getByLabel("Public source link").fill("https://news.example.test/northgate-coo");
    await form.getByLabel("Date of the event").fill("2026-10-28");
    await form.getByRole("button", { name: "Add outside signal" }).click();
    await expect(form.getByRole("status")).toContainText("Leadership change: New COO appointed");
    await page.goto(`${account("northgate")}/signals`);
    const s = page
      .getByTestId("signal")
      .filter({ hasText: "Leadership change: New COO appointed" });
    await expect(s).toContainText("From a public source dated 2026-10-28.");
    await expect(s.getByRole("link", { name: "Public source" })).toHaveAttribute(
      "href",
      "https://news.example.test/northgate-coo",
    );
  });

  test("Priya runs the back-test, activates the proposal (audited), then restores the default as a new version", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/health-model");
    await page.getByRole("button", { name: "Run back-test and propose a model" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Back-test started" })).toBeVisible();
    const sentence = page.getByTestId("proposal-sentence");
    await expect(async () => {
      await page.reload();
      await expect(sentence).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    await expect(sentence).toHaveText(
      /^With this model, we would have flagged \d+ of your last 12 churns, .*out of 12 renewals\.$/,
    );
    await expect(
      page.getByTestId("proposal").getByText(/^Runner-up: With this model/),
    ).toBeVisible();

    const proposal = page.getByTestId("proposal");
    const activate = proposal.getByRole("button", { name: /^Approve and activate v\d+$/ });
    const version = (await activate.textContent())!.replace(/\D/g, "");
    await activate.click();
    await expect(
      page.getByRole("heading", { name: `Active: v${version} · Proposed by back-test` }),
    ).toBeVisible();
    expect(await auditActions(WS)).toContain("health_model.activated");

    // Back to the default weights: previewed first, saved as a new version, then activated.
    const weights = {
      ADOPTION: 30,
      ENGAGEMENT: 15,
      SUPPORT: 15,
      RELATIONSHIP: 20,
      COMMERCIAL: 10,
      SENTIMENT: 10,
    };
    const labels: Record<string, string> = {
      ADOPTION: "Adoption (%)",
      ENGAGEMENT: "Engagement (%)",
      SUPPORT: "Support (%)",
      RELATIONSHIP: "Relationship (%)",
      COMMERCIAL: "Commercial (%)",
      SENTIMENT: "Sentiment (%)",
    };
    for (const [k, v] of Object.entries(weights)) await page.getByLabel(labels[k]!).fill(String(v));
    await page.getByLabel("Healthy from").fill("70");
    await page.getByLabel("Watch from (below is At Risk)").fill("45");
    await page.getByRole("button", { name: "Preview back-test" }).click();
    await expect(page.getByTestId("model-preview")).toContainText("not saved");
    await expect(page.getByTestId("model-preview")).toContainText(
      /flagged \d+ of your last 12 churns/,
    );
    await page.getByRole("button", { name: "Save as a new version" }).click();
    const saved = page.getByRole("status").filter({ hasText: /^Saved as draft v\d+\./ });
    await expect(saved).toBeVisible();
    const draft = (await saved.textContent())!.match(/v(\d+)/)![1]!;
    await page.reload();
    await page
      .getByTestId(`model-v${draft}`)
      .getByRole("button", { name: `Approve and activate v${draft}` })
      .click();
    // The page re-renders when the action finishes; reloading before then would cancel it.
    await expect(
      page.getByRole("heading", { name: `Active: v${draft} · Edited by a person` }),
    ).toBeVisible({ timeout: 15_000 });
    // The saved version holds what was previewed (the form keeps edits across Preview).
    const active = page.locator("section", {
      has: page.getByRole("heading", { name: `Active: v${draft} · Edited by a person` }),
    });
    await expect(active.getByRole("row", { name: /^Adoption/ })).toContainText("30%");
    await expect(active.getByRole("row", { name: /^Relationship/ })).toContainText("20%");
    // The version activated a moment ago is retired, not edited.
    await expect(page.getByTestId(`model-v${version}`)).toContainText(
      `v${version} · Retired · Proposed by back-test`,
    );
  });
});
