import { expect, test } from "@playwright/test";
import { visibleNav } from "../src/config/features";
import { PRODUCT_NAME } from "../src/config/product";
import { auditActions, tryToEditAuditLog } from "./support/db";
import { DEMO_PASSWORD, inviteLinkFor, signIn } from "./support/app";

/**
 * M1 demo script (docs/milestones/M1.md §7) as an end-to-end test against the seeded
 * `_test` database. Runs once (desktop); the a11y spec covers both viewports.
 */
test.describe("M1 foundation", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "flow runs on desktop only");
  });

  test("sign-in, members, invitation, access change and audit trail", async ({ page, browser }) => {
    // 2. Signed-out visitors land on Sign in, which shows the product name.
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: PRODUCT_NAME })).toBeVisible();

    // Wrong password: honest error, no session.
    await page.getByLabel("Email").fill("admin@larkspur.test");
    await page.getByLabel("Password").fill("not the password at all");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "match an account" })).toBeVisible();

    // 3. Priya signs in to Larkspur as Admin.
    await signIn(page, "admin@larkspur.test");
    await expect(page.getByRole("heading", { name: "Larkspur Analytics" })).toBeVisible();
    await expect(page.getByTestId("role")).toHaveText("Admin");
    const nav = page.getByRole("navigation", { name: "Main" });
    // Approved C1 change (M2): exact match against the nav that features.ts declares for this
    // role, so the test keeps proving nav == features.ts as screens ship. Still an exact list.
    const navFor = (role: "ADMIN" | "CSM") =>
      visibleNav({ role, canViewRevenue: role === "ADMIN", bookScope: "OWN" }).map((n) => n.label);
    await expect(nav.getByRole("link")).toHaveText(navFor("ADMIN"));

    // 4. Five seeded members; revenue access only for Priya and Dana.
    await nav.getByRole("link", { name: "Settings" }).click();
    for (const email of [
      "admin@larkspur.test",
      "dana@larkspur.test",
      "leo@larkspur.test",
      "aisha@larkspur.test",
      "tom@larkspur.test",
    ]) {
      await expect(page.getByTestId(`member-${email}`)).toBeVisible();
    }
    await expect(
      page.getByTestId("member-dana@larkspur.test").getByTestId("revenue-badge"),
    ).toBeVisible();
    await expect(
      page.getByTestId("member-admin@larkspur.test").getByTestId("revenue-badge"),
    ).toBeVisible();
    for (const email of ["leo@larkspur.test", "aisha@larkspur.test", "tom@larkspur.test"]) {
      await expect(page.getByTestId(`member-${email}`).getByTestId("revenue-badge")).toHaveCount(0);
    }

    // 5. Invite a new CSM; the dev log transport captures the link.
    const invitee = `newcsm-${Date.now()}@larkspur.test`;
    await page.getByLabel("Email").fill(invitee);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByRole("status")).toHaveText(`Invitation sent to ${invitee}.`);
    const link = await inviteLinkFor(invitee);

    // 6. A private window accepts the invite and lands as a CSM without Settings.
    const privateWindow = await browser.newContext();
    const guest = await privateWindow.newPage();
    await guest.goto(link);
    await expect(guest.getByRole("heading", { name: "Join Larkspur Analytics" })).toBeVisible();
    await guest.getByLabel("Your name").fill("Nina Park");
    await guest.getByLabel("Choose a password").fill(`${DEMO_PASSWORD}-nina`);
    await guest.getByRole("button", { name: "Join workspace" }).click();
    await expect(guest.getByTestId("role")).toHaveText("CSM");
    await expect(guest.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(
      navFor("CSM"),
    );
    expect(navFor("CSM")).not.toContain("Settings");
    const blocked = await guest.goto("/settings/users");
    expect(blocked?.status()).toBe(404);
    await privateWindow.close();

    // 7. Priya widens Leo's book scope to Team.
    await page.reload();
    const leo = page.getByTestId("member-leo@larkspur.test");
    await leo.getByLabel("Accounts leo@larkspur.test sees").selectOption("TEAM");
    await leo.getByRole("button", { name: "Save" }).click();
    await expect(leo.getByRole("status")).toHaveText("Saved.");

    // 8. The audit trail has every step, and it cannot be edited.
    const actions = await auditActions("larkspur-demo");
    for (const a of [
      "auth.signed_in",
      "auth.failed",
      "invitation.created",
      "invitation.accepted",
      "membership.updated",
    ]) {
      expect(actions).toContain(a);
    }
    expect(await tryToEditAuditLog("larkspur-demo")).toMatch(/append-only/);
  });

  test("another tenant's admin sees only their own workspace (Rule 2)", async ({ page }) => {
    await signIn(page, "admin@ferngrove.test");
    await expect(page.getByRole("heading", { name: "Ferngrove Software" })).toBeVisible();
    await page.goto("/settings/users");
    await expect(page.getByTestId("member-admin@ferngrove.test")).toBeVisible();
    await expect(page.getByText("@larkspur.test")).toHaveCount(0);
  });
});
