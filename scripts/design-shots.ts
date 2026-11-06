/**
 * `pnpm exec tsx --env-file=.env scripts/design-shots.ts --out <dir> [--base http://localhost:3000] [--only 0,3]`
 * (`--only`: comma-separated name prefixes, e.g. `0` = CSM screens, `2` = settings, `3` = customer pages)
 *
 * DEV ONLY (M12 design pass; refused in production). Screenshots every screen the design pass
 * touches, at desktop width, plus the customer-facing pages at phone width, against a running
 * dev server on the seeded demo (Larkspur Analytics). Mints a portal link and a survey link for
 * Brightwell Logistics, the seeded portal account, so those pages render real content.
 * Reads only; the one write is the portal access row the link needs.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { createPortalAccess } from "@/modules/portal/service";
import { createSurveyToken } from "@/modules/surveys/service";
import { DEMO_PASSWORD } from "../prisma/seed/users";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/**
 * Signs in once per person and reuses the saved session (test-results/design-auth, git-ignored), so
 * repeated runs stay under the sign-in rate limit (5 per email per 10 minutes).
 */
async function contextFor(browser: Browser, base: string, email: string): Promise<Page> {
  const dir = path.join("test-results", "design-auth");
  mkdirSync(dir, { recursive: true });
  const state = path.join(dir, `${email}.json`);
  const viewport = { width: 1440, height: 900 };
  if (existsSync(state)) {
    const page = await (await browser.newContext({ viewport, storageState: state })).newPage();
    await page.goto(`${base}/today`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    if (/\/today$/.test(page.url())) return page;
    await page.context().close();
  }
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto(`${base}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/today$/, { timeout: 60_000 });
  await page.context().storageState({ path: state });
  return page;
}

async function main() {
  if (env().NODE_ENV === "production") throw new Error("refused in production");
  const out = arg("out");
  if (!out) throw new Error("usage: … --out <dir>");
  const base = arg("base") ?? "http://localhost:3000";
  const ws = await findWorkspaceBySlug("larkspur-demo");
  if (!ws) throw new Error("seed the demo first (pnpm db:seed)");
  const db = scopedDb({ workspaceId: ws.id });
  const bw = await db.account.findFirstOrThrow({ where: { name: "Brightwell Logistics" } });
  const ng = await db.account.findFirstOrThrow({ where: { name: "Northgate Freight" } });
  const contact = await db.contact.findFirstOrThrow({ where: { accountId: bw.id } });
  const survey = await db.survey.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const { rawToken } = await createPortalAccess(
    { workspaceId: ws.id },
    { accountId: bw.id, contactId: contact.id },
  );
  const surveyToken = createSurveyToken({
    workspaceId: ws.id,
    surveyId: survey.id,
    accountId: bw.id,
    contactId: contact.id,
  });

  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const only = arg("only")?.split(",");
  const wanted = (name: string) => !only || only.some((p) => name.startsWith(p));
  const shot = async (page: Page, name: string, url: string) => {
    if (!wanted(name)) return;
    await page.goto(`${base}${url}`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    console.log(`shot ${name}`);
  };

  const anon = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await shot(anon, "01-sign-in", "/sign-in");
  const desk = await contextFor(browser, base, "dana@larkspur.test");
  const csm: Array<[string, string]> = [
    ["02-today", "/today"],
    ["03-accounts", "/accounts"],
    ["04-account-360", `/accounts/${ng.id}`],
    ["05-account-health-tab", `/accounts/${ng.id}/health`],
    ["06-health", "/health"],
    ["07-approvals", "/approvals"],
    ["08-ask", "/ask"],
    ["09-renewals", "/renewals"],
    ["10-reports", "/reports"],
    ["11-inbox", "/inbox"],
    ["12-tasks", "/tasks"],
  ];
  for (const [n, u] of csm) await shot(desk, n, u);
  const adminPage = await contextFor(browser, base, "admin@larkspur.test");
  const admin: Array<[string, string]> = [
    ["20-settings-users", "/settings/users"],
    ["21-settings-integrations", "/settings/integrations"],
    ["22-settings-data", "/settings/data"],
    ["23-settings-ai-team", "/settings/ai-team"],
    ["24-settings-audit", "/settings/audit"],
    ["25-settings-jobs", "/settings/system/jobs"],
    ["26-pilot-metrics", "/reports/pilot-metrics"],
  ];
  for (const [n, u] of admin) await shot(adminPage, n, u);
  const customer: Array<[string, string]> = [
    ["30-portal", `/portal/${rawToken}`],
    ["31-portal-invalid", "/portal/not-a-real-token-0123456789abcdef0123456789abcdef"],
    ["32-survey", `/s/${surveyToken}`],
    ["33-survey-invalid", "/s/not.a-token"],
    ["34-not-found", "/no-such-page"],
  ];
  const pub = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const [n, u] of customer) await shot(pub, n, u);
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  for (const [n, u] of customer.slice(0, 4)) await shot(phone, `${n}-phone`, u);
  await browser.close();
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
