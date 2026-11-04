import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

/** axe on the M9 screens at desktop and 375 px (both projects run this file). */
test("axe: inbox, unmatched queue, promises, sentiment & themes, and the account tabs", async ({
  page,
}) => {
  await signIn(page, "dana@larkspur.test");
  const accounts = await inWorkspace(WS, async (tx, ws) => ({
    halden: await tx.account.findFirstOrThrow({
      where: { workspaceId: ws, name: "Halden Retail" },
    }),
    brightwell: await tx.account.findFirstOrThrow({
      where: { workspaceId: ws, name: "Brightwell Logistics" },
    }),
  }));
  const pages = [
    "/inbox?status=ALL",
    "/inbox/unmatched",
    "/promises?status=ALL",
    "/health/sentiment",
    "/health/sentiment?theme=csv_export",
    `/accounts/${accounts.halden.id}/promises`,
    `/accounts/${accounts.halden.id}/conversations`,
    `/accounts/${accounts.brightwell.id}/people`,
  ];
  for (const p of pages) {
    await page.goto(p);
    await expectNoBlockingViolations(page);
  }
});
