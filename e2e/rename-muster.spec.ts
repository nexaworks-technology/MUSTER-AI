import path from "node:path";
import { expect, test } from "@playwright/test";
import { PRODUCT_NAME } from "../src/config/product";
import { signIn } from "./support/app";
import { ensureM11Data } from "./support/m11";
import { inWorkspace } from "./support/m4";

/** The product is named by PRODUCT_NAME alone; the old working name is gone from every screen. */
const OLD = "NexaWorks AI CSM";

test("sign-in page and tab title carry the product name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: PRODUCT_NAME })).toBeVisible();
  expect(await page.title()).toContain(PRODUCT_NAME);
  expect(await page.content()).not.toContain(OLD);
  await page.screenshot({ path: path.join(process.cwd(), "docs/design/rename-signin.png") });
});

test("Ask byline and the app shell show the product name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(600_000);
  await ensureM11Data("larkspur-demo");
  await signIn(page, "dana@larkspur.test");
  const id = await inWorkspace("larkspur-demo", async (tx, ws) => {
    const m = await tx.askMessage.findFirstOrThrow({
      where: {
        workspaceId: ws,
        role: "USER",
        content: { contains: "mentioned a competitor" },
        thread: { user: { email: "dana@larkspur.test" } },
      },
      orderBy: { createdAt: "desc" },
    });
    return m.threadId;
  });
  await page.goto(`/ask/${id}`);
  const answer = page.getByTestId("ai-text").first();
  await expect(answer).toContainText(PRODUCT_NAME);
  await expect(page.locator("aside")).toContainText(PRODUCT_NAME);
  expect(await page.content()).not.toContain(OLD);
  await page.screenshot({ path: path.join(process.cwd(), "docs/design/rename-ask-byline.png") });
});
