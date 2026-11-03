import { test } from "@playwright/test";
import { seedId } from "../prisma/seed/run";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace, prepareM4 } from "./support/m4";

/**
 * M4 acceptance #16: axe (WCAG 2.1 AA, no serious or critical violations) on Today, Approvals,
 * an approval, Draft check-in, Settings › Audit, Settings › AI team and an agent run, at 1280 px
 * and 375 px. Home is checked here too: since sign-in now lands on Today, `a11y.spec.ts`'s first
 * page is Today rather than Home. A new file: pre-M4 a11y specs are not edited.
 */
const WS = "larkspur-demo";

test.beforeAll(() => {
  prepareM4(WS);
});

test("axe: today, approvals, check-in, audit, AI team, agent run, home", async ({ page }) => {
  await signIn(page, "admin@larkspur.test");
  const { approvalId, runId, signalId } = await inWorkspace(WS, async (tx) => ({
    approvalId: (await tx.approval.findFirst({ orderBy: { createdAt: "desc" } }))?.id,
    runId: (
      await tx.agentRun.findFirst({ where: { agentKey: "health-analyst", status: "SUCCEEDED" } })
    )?.id,
    signalId: (
      await tx.signal.findFirst({
        where: {
          accountId: seedId("account:brightwell"),
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
        },
      })
    )?.id,
  }));
  const pages = [
    "/today",
    "/approvals",
    "/approvals?status=DECIDED",
    ...(approvalId ? [`/approvals/${approvalId}`] : []),
    ...(signalId ? [`/approvals/new?sourceType=Signal&sourceId=${signalId}`] : []),
    "/settings/audit",
    "/settings/ai-team",
    ...(runId ? [`/agent-runs/${runId}`] : []),
    `/accounts/${seedId("account:brightwell")}/health`,
    "/",
  ];
  for (const p of pages) {
    await page.goto(p);
    await page
      .locator("details")
      .evaluateAll((all) => all.forEach((d) => d.setAttribute("open", "")));
    await expectNoBlockingViolations(page);
  }
});
