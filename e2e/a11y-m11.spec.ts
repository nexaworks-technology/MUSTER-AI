import { test } from "@playwright/test";
import { signIn } from "./support/app";
import { expectNoBlockingViolations } from "./support/axe";
import { ensureM11Data } from "./support/m11";
import { inWorkspace } from "./support/m4";

const WS = "larkspur-demo";

/** axe on the M11 screens at desktop and 375 px (both projects run this file). */
test("axe: ask, reports, ledger, save record, ai accuracy, trend, digest, workspace settings", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "desktop") test.setTimeout(240_000);
  await ensureM11Data(WS);
  await signIn(page, "dana@larkspur.test");
  const ids = await inWorkspace(WS, async (tx, ws) => {
    const thread = await tx.askThread.findFirst({
      where: { workspaceId: ws, user: { email: "dana@larkspur.test" } },
      orderBy: { createdAt: "desc" },
    });
    const outcome = await tx.outcomeRecord.findFirst({
      where: { workspaceId: ws },
      orderBy: { createdAt: "desc" },
    });
    return { thread: thread?.id, outcome: outcome?.id };
  });

  const pages = [
    "/ask",
    ...(ids.thread ? [`/ask/${ids.thread}`] : []),
    "/reports",
    "/reports/outcomes?period=365",
    ...(ids.outcome ? [`/reports/outcomes/${ids.outcome}`] : []),
    "/reports/ai-accuracy",
    "/reports/portfolio-health-trend",
    "/reports/digest",
    "/settings/workspace",
  ];
  for (const p of pages) {
    await page.goto(p);
    await expectNoBlockingViolations(page);
  }
});
