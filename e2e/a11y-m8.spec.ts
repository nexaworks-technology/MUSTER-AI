import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { inWorkspace } from "./support/m4";
import { prepareM8 } from "./support/m8";

const WS = "larkspur-demo";

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== "desktop") return;
  await prepareM8(WS);
});

test("axe: plays list, play detail, play results, campaigns list, new campaign", async ({ page }) => {
  await signIn(page, "dana@larkspur.test");

  const play = await inWorkspace(WS, (tx, ws) =>
    tx.play.findFirstOrThrow({ where: { workspaceId: ws, key: "health-risk" } }),
  );

  const pages = [
    "/plays",
    `/plays/${play.id}`,
    `/plays/${play.id}/results`,
    "/campaigns",
    "/campaigns/new",
  ];

  for (const p of pages) {
    await page.goto(p);
    await expectNoBlockingViolations(page);
  }
});
