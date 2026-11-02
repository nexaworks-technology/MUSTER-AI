import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { DEMO_PASSWORD } from "../../prisma/seed/users";

export { DEMO_PASSWORD };

export async function signIn(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Reads the invitation link from the newest dev-mail message sent to `to`. */
export async function inviteLinkFor(to: string): Promise<string> {
  const dir = path.join(process.cwd(), ".dev-mail");
  for (let attempt = 0; attempt < 20; attempt++) {
    const files = (await readdir(dir).catch(() => [])).sort().reverse();
    for (const f of files) {
      const mail = JSON.parse(await readFile(path.join(dir, f), "utf8")) as {
        to: string;
        text: string;
      };
      if (mail.to === to) return /(http\S+\/invite\/[A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No dev mail for ${to}`);
}
