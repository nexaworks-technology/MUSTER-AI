import { expect, test } from "@playwright/test";
import { signIn } from "./support/app";

/**
 * Ask AI redesign: the thread-title regression. A stored title was missing its first character
 * ("hich accounts are at risk and why?"). The stored question itself lacked the letter, so it was
 * lost in the browser before submit: the question box was a CONTROLLED textarea, and React
 * resets a controlled field to its state ("") when it hydrates, wiping anything typed while the
 * page's JavaScript was still loading. Slow connection (the tunnel) plus a fast typist reproduces it.
 */
test("text typed before the page hydrates is kept (no clipped first character)", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "behaviour is not viewport specific");
  await signIn(page, "dana@larkspur.test");
  // Hold every script chunk back so the form is on screen, un-hydrated, while we type.
  await page.route("**/_next/static/chunks/**", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto("/ask", { waitUntil: "commit" });
  const box = page.locator("#ask-question");
  await box.waitFor({ state: "visible" });
  const question = "Which accounts are at risk and why?";
  await box.pressSequentially(question, { delay: 0 });
  // React tags a DOM node with __reactProps$… when it hydrates it.
  await page.waitForFunction(() => {
    const el = document.querySelector("#ask-question");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  });
  await expect(box).toHaveValue(question);
});

/** The conversation, Claude pattern: structure and trust elements survive, in both themes. */
import path from "node:path";
import { PRODUCT_NAME } from "../src/config/product";
import { ensureM11Data } from "./support/m11";
import { inWorkspace } from "./support/m4";

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: reading column, text answers, quiet trust elements, floating composer`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "visual structure is checked on desktop");
    test.setTimeout(600_000);
    await ensureM11Data("larkspur-demo");
    await context.addCookies([
      { name: "nx-theme", value: theme, url: `http://localhost:${process.env.E2E_PORT ?? 3100}` },
    ]);
    await signIn(page, "dana@larkspur.test");
    const threadId = await inWorkspace("larkspur-demo", async (tx, ws) => {
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
    await page.goto(`/ask/${threadId}`);
    const messages = page.getByTestId("ask-messages");
    await expect(messages).toContainText("Tallyfield");

    // One centred reading column, at most ~760px.
    const col = (await messages.boundingBox())!;
    expect(col.width).toBeLessThanOrEqual(762);
    const paper = (await page.locator("main#main").boundingBox())!;
    const thread = (await page.getByTestId("thread-list").boundingBox())!;
    const left = col.x - (thread.x + thread.width);
    const right = paper.x + paper.width - (col.x + col.width);
    expect(Math.abs(left - right)).toBeLessThan(40); // centred in the space beside the list

    // Thread list: plain text rows, no card.
    const list = await page
      .getByTestId("thread-list")
      .evaluate((el) => ({
        b: getComputedStyle(el).borderTopWidth,
        bg: getComputedStyle(el).backgroundColor,
      }));
    expect(list.b).toBe("0px");
    expect(list.bg).toBe("rgba(0, 0, 0, 0)");

    // The answer is text on the page: no card, border or bubble; headed by the mark and the name.
    const answer = messages.getByTestId("ai-text").first();
    const look = await answer.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
    });
    expect(look).toEqual({ bg: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none" });
    await expect(answer).toContainText(PRODUCT_NAME);
    await expect(answer.locator("svg").first()).toBeVisible();

    // The user's message: one soft bubble, right-aligned.
    const bubble = messages.locator('li[data-role="USER"] p').first();
    const bb = (await bubble.boundingBox())!;
    expect(bb.x + bb.width).toBeGreaterThan(col.x + col.width - 8);
    expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );

    // Trust elements survive, quieter: numbered pills, one caption, "What it read" with a chevron.
    const pills = answer.getByTestId("ai-sources").locator("li");
    await expect(pills.first()).toContainText(/^1\s*\S/);
    await expect(answer.getByText(/confidence/i)).toHaveCount(1);
    const read = answer.getByRole("link", { name: /what it read/i });
    await expect(read).toHaveAttribute("href", /\/agent-runs\/.+/);
    await expect(read.locator("svg")).toHaveCount(1);

    // Composer: floating rounded box, circular accent send button, grows with its text.
    const send = page.getByRole("button", { name: "Ask", exact: true });
    expect(await send.evaluate((el) => getComputedStyle(el).borderRadius)).toMatch(
      /9999|50%|\d{3,}/,
    );
    const box = page.locator("#ask-question");
    const before = (await box.boundingBox())!.height;
    await box.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("x");
    expect((await box.boundingBox())!.height).toBeGreaterThan(before + 20);
    await box.fill("");

    await page.screenshot({
      path: path.join(process.cwd(), `docs/design/ask-claude-${theme}.png`),
    });
  });
}

test("empty state: quiet starter rows fill the box, nothing is sent", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await signIn(page, "dana@larkspur.test");
  await page.goto("/ask");
  await expect(page.getByRole("heading", { name: "Try asking" })).toBeVisible();
  await page.getByRole("button", { name: "Which accounts are at risk and why?" }).click();
  await expect(page.locator("#ask-question")).toHaveValue("Which accounts are at risk and why?");
  await expect(page).toHaveURL(/\/ask$/);
});
