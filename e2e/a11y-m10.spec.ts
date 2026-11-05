import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

/** axe on the M10 screens at desktop and 375 px (both projects run this file). */
test("axe: today with meetings, new qbr, success plans tab, surveys settings, customer portal", async ({
  page,
}) => {
  await signIn(page, "dana@larkspur.test");
  const accounts = await inWorkspace(WS, async (tx, ws) => ({
    brightwell: await tx.account.findFirstOrThrow({
      where: { workspaceId: ws, name: "Brightwell Logistics" },
    }),
  }));

  const pages = [
    "/today",
    "/meetings/qbr/new",
    "/settings/surveys",
    `/accounts/${accounts.brightwell.id}/plans`,
    "/portal/sample-token-string-for-a11y-testing-32chars",
  ];

  for (const p of pages) {
    await page.goto(p);
    await expectNoBlockingViolations(page);
  }
});
