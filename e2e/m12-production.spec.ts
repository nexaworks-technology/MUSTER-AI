import { expect, test, type Page } from "@playwright/test";
import { E2E_RECORDINGS } from "../playwright.config";
import { signIn } from "./support/app";
import { inWorkspace, runScript } from "./support/m4";

/**
 * M12 B7 — the PRODUCTION BUILD under a real browser (D-182, D-175):
 * 1. The production CSP is strict (script and style nonce-only, no 'unsafe-eval', no inline
 *    <style>) and the app runs under it: loading every main screen raises ZERO
 *    `securitypolicyviolation` events and no CSP console errors.
 * 2. Q-47 closed: the app server runs the recorded AI transport, so an in-app Ask AI question is
 *    answered through the real loop in the browser (recordings composed from the records first).
 */
const WS = "larkspur-demo";

async function watchCsp(page: Page): Promise<() => string[]> {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text()))
      seen.push(`${new URL(page.url()).pathname} console: ${m.text().slice(0, 160)}`);
  });
  // Reported to Node as they happen, so a violation on any page of the walk is kept.
  await page.exposeFunction("__reportCsp", (v: string) => seen.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const report = (window as unknown as { __reportCsp: (v: string) => void }).__reportCsp;
      void report(
        `${location.pathname} ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
      );
    });
  });
  return () => seen;
}

test.describe("M12 production build", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "runs once, on desktop");
  });

  test("the production CSP is strict and every main screen runs under it with no violations", async ({
    page,
  }) => {
    const res = await page.request.get("/sign-in");
    const csp = res.headers()["content-security-policy"] ?? "";
    const directive = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toMatch(/'nonce-[^']+'/);
    expect(directive("script-src")).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(directive("style-src")).toMatch(/'nonce-[^']+'/);
    expect(directive("style-src")).not.toContain("unsafe-inline");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");

    const violations = await watchCsp(page);
    await signIn(page, "dana@larkspur.test");
    const account = await inWorkspace(WS, (tx) =>
      tx.account.findFirstOrThrow({ where: { name: "Northgate Freight" }, select: { id: true } }),
    );
    const paths = [
      "/today",
      "/accounts",
      `/accounts/${account.id}`,
      `/accounts/${account.id}/health`,
      "/approvals",
      "/renewals",
      "/plays",
      "/inbox",
      "/ask",
      "/reports",
      "/reports/outcomes",
      "/settings/data", // Dana is not an Admin: the app's own 404, under the same CSP
      "/no-such-page",
      "/portal/not-a-real-token-but-long-enough-0123456789abcdef",
      "/s/not.a-token",
    ];
    for (const p of paths) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      // Client navigation and hydration ran: the document reached a React-rendered heading.
      await expect(page.locator("h1").first()).toBeVisible();
      // A <style> the CSP refused stays in the DOM: name it, so a failure says what was blocked.
      const unsigned = await page.evaluate(() =>
        [...document.querySelectorAll("style")]
          .filter((el) => !el.nonce)
          .map((el) => el.outerHTML.slice(0, 200)),
      );
      for (const html of unsigned) violations().push(`${p} unsigned <style>: ${html}`);
    }
    // An Admin sees the real Data controls (export, deletion) under the same CSP.
    await page.context().clearCookies();
    await signIn(page, "admin@larkspur.test");
    await page.goto("/settings/data");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(violations()).toEqual([]);
  });

  test("Q-47: an in-app Ask AI question is answered in the browser on recorded answers", async ({
    page,
  }) => {
    const question = "What is Fairhaven Dental Group's contract value?";
    const out = runScript("scripts/recorded-ask.ts", ["--workspace", WS, "--question", question], {
      AI_PROVIDER: "recorded",
      AI_RECORDINGS_DIR: E2E_RECORDINGS,
    });
    expect(out).toContain("SUCCEEDED");
    await signIn(page, "dana@larkspur.test");
    await page.goto("/ask");
    await page.getByLabel("Ask about your accounts").fill(question);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByTestId("ask-messages")).toContainText(
      "I cannot see a contract for Fairhaven Dental Group.",
      { timeout: 30_000 },
    );
  });
});
