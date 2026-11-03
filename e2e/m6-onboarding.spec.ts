import { expect, test, type Page } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { inWorkspace, runScript } from "./support/m4";
import { prepareM6, resetUsageApi } from "./support/m6";

/**
 * M6 demo script (docs/milestones/M6.md §7, with the founder's corrections D6/D7: Adoption is a
 * tab beside Usage, and Pinecrest is in Aisha's book) against the seeded `_test` database, frozen
 * at SEED_TODAY. Agent runs come from the RECORDED transport (see e2e/support/m6.ts); every send
 * goes through dispatch to the log-only transport. Usage events go through the real Usage API and
 * the worker, posted by `pnpm demo:usage`. Re-seeded, never reset: steps make their own rows.
 */
const WS = "larkspur-demo";
const account = (key: string) => `/accounts/${seedId(`account:${key}`)}`;
const NONCE = `e2e-${Date.now()}`;
const featureCount = async (page: Page) => {
  const text = (await page.getByTestId("adoption-features").textContent()) ?? "";
  const m = /(\d+) of (\d+) features/.exec(text);
  return { never: Number(m![1]), bought: Number(m![2]), text };
};

test.describe("M6 onboarding and adoption", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== "desktop") return;
    await resetUsageApi(WS);
    const out = prepareM6(WS, NONCE);
    expect(out).toContain("AI transport: RECORDED");
    expect(out).toContain("onboarding-manager Pinecrest: SUCCEEDED");
    expect(out).toContain("adoption-coach Pinecrest: SUCCEEDED");
  });

  test("Aisha's Onboarding list: Pinecrest is Stalled, with the likely blocker and time to value", async ({
    page,
  }) => {
    await signIn(page, "aisha@larkspur.test");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Onboarding" })
      .click();
    await expect(page.getByRole("heading", { name: "Onboarding", exact: true })).toBeVisible();
    const row = page.getByTestId("onboarding-row-Pinecrest Health");
    await expect(row).toContainText("Stalled");
    await expect(row).toContainText("SSO setup (customer) overdue 12 days");
    await expect(row).toContainText(/Day \d+( \(late\))?: similar accounts reach value by day \d+/);
    // The stalled accounts are in Aisha's book; Leo's two are not on her list.
    await expect(page.getByTestId("onboarding-row-Cobalt Ridge Transit")).toHaveCount(0);
  });

  test("Pinecrest › Onboarding: steps with owners and dates, a step done by a product event with its proof, the stall raised as a signal, the handoff with sources and an honest gap", async ({
    page,
  }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto(`${account("pinecrest")}/onboarding`);
    await expect(page.getByTestId("onboarding-status")).toContainText(
      "Stalled: SSO setup (customer) overdue 12 days",
    );
    const sso = page.getByTestId("step-sso");
    await expect(sso).toContainText("Customer (Raj Patel)");
    await expect(sso).toContainText(/due Oct 21, 2026/);
    await expect(sso).toContainText("Overdue 12 days");
    // A step the product itself completed: who did what is not asserted by a person, the rows prove it.
    const dashboard = page.getByTestId("step-first_dashboard");
    await expect(dashboard).toContainText("product usage showed it");
    await dashboard.getByTestId("proof").locator("summary").click();
    await expect(dashboard.getByTestId("proof").getByRole("link").first()).toBeVisible();
    // The handoff: items with sources, and the missing one says so.
    const handoff = page.getByTestId("handoff");
    await expect(handoff).toContainText("Not found in CRM");
    expect(await handoff.getByRole("link").count()).toBeGreaterThanOrEqual(1);
    // The stall is also an open signal on the account.
    await page.goto(`${account("pinecrest")}/signals`);
    await expect(
      page.getByText("Onboarding stalled: SSO setup (customer) overdue 12 days").first(),
    ).toBeVisible();
  });

  test("the stalled plan told its owner in the bell", async ({ page }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto("/notifications");
    await expect(
      page
        .getByTestId("notification")
        .filter({
          hasText: "Onboarding stalled at Pinecrest Health: SSO setup (customer) overdue 12 days",
        })
        .first(),
    ).toBeVisible();
  });

  test("Approvals: the Onboarding Manager's check-in for the IT contact, with reason and proof; edit one sentence, approve: sent through dispatch", async ({
    page,
  }) => {
    const pending = await inWorkspace(WS, (tx) =>
      tx.approval.findFirstOrThrow({
        where: { status: "PENDING", proposedByRun: { is: { agentKey: "onboarding-manager" } } },
        orderBy: { createdAt: "desc" },
      }),
    );
    await signIn(page, "aisha@larkspur.test");
    await page.goto("/approvals");
    await expect(
      page.getByText("Onboarding check-in: SSO setup (customer) overdue 12 days").first(),
    ).toBeVisible();
    await page.goto(`/approvals/${pending.id}`);
    await expect(page.getByTestId("approval-level")).toHaveText("Draft for approval");
    const proof = page.getByTestId("approval-proof");
    await expect(
      proof.getByRole("link", { name: /Onboarding plan: Pinecrest Health/ }),
    ).toBeVisible();
    await expect(proof.getByRole("link", { name: /Onboarding step: SSO setup/ })).toBeVisible();
    await expect(page.getByText("raj.patel@pinecrest-health.test")).toBeVisible();

    await page.getByRole("button", { name: "Edit before approving" }).click();
    await page
      .getByRole("textbox", { name: "Message" })
      .fill(
        "Hi Raj,\n\nThe SSO setup step is now 12 days overdue. Could we look at it together this week?\n\nAisha",
      );
    await page.getByRole("button", { name: "Save edit and approve" }).click();
    await expect(page.getByTestId("message-status")).toContainText(
      /sent, sent .*\(log transport\)/,
    );
    await expect(page.getByTestId("approval-status")).toHaveText("edited approved");
    const message = await inWorkspace(WS, (tx) =>
      tx.outboundMessage.findFirstOrThrow({ where: { approvalId: pending.id } }),
    );
    expect(message).toMatchObject({
      status: "SENT",
      transport: "log",
      toEmail: "raj.patel@pinecrest-health.test",
      origin: "AI",
    });
    expect(message.bodyText).toContain("Could we look at it together this week?");
  });

  test("Pinecrest › Adoption: features never used, power users, and the Adoption Coach's finding with its sources; its nudge waits in Approvals", async ({
    page,
  }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto(`${account("pinecrest")}/adoption`);
    const before = await featureCount(page);
    expect(before.never).toBeGreaterThan(0);
    await expect(page.getByTestId("adoption-features")).toContainText("Growth plan");
    const coach = page.getByTestId("adoption-coach");
    await expect(coach.getByTestId("ai-item").first()).toContainText("never been used");
    expect(
      await coach.getByTestId("ai-sources").first().getByRole("listitem").count(),
    ).toBeGreaterThanOrEqual(2);
    await expect(coach).toContainText("model confidence");
    await expect(coach).toContainText("Nothing is sent without a person");
    // The nudge is a draft: pending, never sent.
    const nudge = await inWorkspace(WS, (tx) =>
      tx.approval.findFirstOrThrow({
        where: { status: "PENDING", proposedByRun: { is: { agentKey: "adoption-coach" } } },
        include: { outboundMessages: true },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(nudge.outboundMessages[0]).toMatchObject({ status: "AWAITING_APPROVAL", sentAt: null });
    await page.goto("/approvals");
    await expect(page.getByText("Adoption nudge:").first()).toBeVisible();
  });

  test("Usage API: Admin generates a key (shown once), demo:usage sends events twice, the second run changes nothing, the Adoption tab moves", async ({
    page,
  }) => {
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/integrations");
    const card = page.getByRole("region", { name: /Usage API/ });
    await card.getByRole("button", { name: "Generate key" }).click();
    const keyBox = card.getByTestId("usage-key-once");
    await expect(keyBox).toBeVisible();
    const key = (await keyBox.textContent())!.trim();
    expect(key).toMatch(/^nxu_[A-Za-z0-9_-]{43}$/);
    await expect(card.getByTestId("usage-key-status")).toContainText(`ending ${key.slice(-4)}`);
    // Shown once: after a reload only the last four characters remain.
    await page.reload();
    await expect(page.getByTestId("usage-key-once")).toHaveCount(0);
    await expect(page.getByTestId("usage-key-status")).toContainText(`ending ${key.slice(-4)}`);
    await expect(page.getByTestId("status-USAGE_API")).toHaveText(
      "Connected · receives your events",
    );

    const integration = await inWorkspace(WS, (tx) =>
      tx.integration.findFirstOrThrow({ where: { provider: "USAGE_API" } }),
    );
    expect(integration.ingestKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(integration)).not.toContain(key);

    const send = () =>
      runScript(
        "scripts/demo-usage.ts",
        ["pinecrest", "--key", key, "--url", "http://localhost:3100"],
        {},
      );
    const rows = () =>
      inWorkspace(WS, async (tx, workspaceId) => ({
        batches: await tx.usageIngestBatch.count({ where: { workspaceId } }),
        features: JSON.stringify(
          await tx.featureUsageDaily.findMany({
            where: { workspaceId, source: "USAGE_API" },
            orderBy: [{ featureKey: "asc" }, { date: "asc" }],
          }),
        ),
        users: await tx.userUsageDaily.count({ where: { workspaceId, source: "USAGE_API" } }),
      }));

    const first = send();
    expect(first).toContain("HTTP 202");
    expect(first).toContain('"accepted":8');
    await expect.poll(async () => (await rows()).batches, { timeout: 30_000 }).toBe(1);
    const afterFirst = await rows();
    expect(afterFirst.features).toContain("data_connectors");
    expect(afterFirst.features).toContain("scheduled_reports");

    const second = send();
    expect(second).toContain("HTTP 202");
    await page.waitForTimeout(3_000); // the worker has had its chance to (not) apply a replay
    expect(await rows()).toEqual(afterFirst);

    // The Settings card says what the last batch did.
    await page.goto("/settings/integrations");
    await expect(page.getByTestId("usage-last-batch")).toContainText(
      "8 events folded into daily totals and discarded",
    );

    // The Adoption tab moved: the two features the events used are no longer "never used".
    await page.goto(`${account("pinecrest")}/adoption`);
    const after = await featureCount(page);
    expect(after.bought).toBeGreaterThan(0);
    await expect(page.getByTestId("adoption-features")).not.toContainText(
      "Data connectors, Scheduled reports",
    );
    const body = (await page.locator("main").textContent()) ?? "";
    expect(body).toMatch(/In use:.*Data connectors/);
    expect(body).toMatch(/In use:.*Scheduled reports/);
  });

  test("a wrong key is refused and nothing is stored", async ({ request }) => {
    const before = await inWorkspace(WS, (tx) => tx.usageIngestBatch.count());
    const res = await request.post("/api/usage/v1/track", {
      headers: { authorization: "Bearer nxu_not-a-real-key-at-all" },
      data: { userId: "x", groupId: "pinecrest-health.test", event: "Opened" },
    });
    expect(res.status()).toBe(401);
    expect(await inWorkspace(WS, (tx) => tx.usageIngestBatch.count())).toBe(before);
  });

  test("a completed account's time to value against its cohort", async ({ page }) => {
    await signIn(page, "aisha@larkspur.test");
    await page.goto(`${account("juniper-vet")}/onboarding`);
    await expect(page.getByTestId("onboarding-status")).toContainText("Value reached");
    await expect(page.getByTestId("onboarding-ttv")).toContainText(
      /Value reached on day \d+\. Similar accounts \(.+, \d+ peers?\) reach it by day \d+/,
    );
    await page.getByTestId("proof").first().locator("summary").click();
    await expect(page.getByTestId("proof").first().getByRole("link").first()).toBeVisible();
  });

  test("a new plan is created from the matching template: steps with owners and dates, on track", async ({
    page,
  }) => {
    const created = await inWorkspace(WS, async (tx, workspaceId) => {
      const aisha = await tx.membership.findFirstOrThrow({
        where: { workspaceId, user: { email: "aisha@larkspur.test" } },
      });
      return tx.account.create({
        data: {
          workspaceId,
          name: `Plan Demo ${Date.now()}`,
          tier: "MID_TOUCH",
          plan: "Growth",
          lifecycleStage: "ONBOARDING",
          ownerMembershipId: aisha.id,
        },
      });
    });
    await signIn(page, "aisha@larkspur.test");
    await page.goto(`/accounts/${created.id}/onboarding`);
    await expect(page.getByText("No onboarding plan yet.")).toBeVisible();
    await page.getByRole("button", { name: "Start onboarding from the matching template" }).click();
    await expect(page.getByText("Onboarding plan started.")).toBeVisible();
    await expect(page.getByTestId("onboarding-status")).toContainText("On track");
    const steps = page.locator('[data-testid^="step-"]');
    expect(await steps.count()).toBeGreaterThanOrEqual(3);
    await expect(steps.first()).toContainText(/Us \(Aisha Bello\)|Customer/);
    await expect(steps.first()).toContainText(/due \w{3} \d+, \d{4}/);
  });
});
