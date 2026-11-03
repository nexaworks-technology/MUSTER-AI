/**
 * `pnpm demo:webhook <stripe|chargebee> payment_failed <sundial|kestrel> [--workspace <slug>] [--forged] [--auth user:password]`
 *
 * DEV-ONLY (refused in production). Posts a recorded fixture webhook to the RUNNING app, signed the
 * way the provider signs it, so the demo shows the real intake path: verify → store → dedupe →
 * process → signal in Today. Stripe signs with STRIPE_WEBHOOK_SECRET from the env, which must be
 * the secret you typed when connecting Stripe (D3); Chargebee uses `--auth user:password`, the
 * Basic credentials you set. `--forged` signs with a wrong secret to show the 401 (nothing stored).
 * Prints the HTTP answer only; never the secret.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/config/env";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { scopedDb } from "@/lib/db/scoped";

const FIXTURES: Record<
  string,
  { provider: "STRIPE" | "CHARGEBEE"; file: string; account: string }
> = {
  "stripe:payment_failed:sundial": {
    provider: "STRIPE",
    file: "stripe/__fixtures__/webhook-invoice-payment-failed.json",
    account: "Sundial Fitness",
  },
  "chargebee:payment_failed:kestrel": {
    provider: "CHARGEBEE",
    file: "chargebee/__fixtures__/webhook-payment-failed.json",
    account: "Kestrel Robotics",
  },
};

const flag = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  if (env().NODE_ENV === "production") throw new Error("demo:webhook is a development tool");
  const [providerArg, event, account] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const key = `${providerArg}:${event}:${account}`;
  const fixture = FIXTURES[key];
  if (!fixture)
    throw new Error(
      `usage: pnpm demo:webhook ${Object.keys(FIXTURES)
        .map((k) => k.replaceAll(":", " "))
        .join(" | ")}`,
    );
  const slug = arg("workspace") ?? "larkspur-demo";
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const integration = await scopedDb({ workspaceId: ws.id }).integration.findUnique({
    where: { workspaceId_provider: { workspaceId: ws.id, provider: fixture.provider } },
    select: { id: true },
  });
  if (!integration) throw new Error(`${fixture.provider} is not connected in ${slug}`);
  const raw = readFileSync(
    path.join(process.cwd(), "src/modules/integrations/adapters", fixture.file),
    "utf8",
  );
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (fixture.provider === "STRIPE") {
    const secret = flag("forged") ? "whsec_forged_by_demo" : env().STRIPE_WEBHOOK_SECRET;
    if (!secret)
      throw new Error("Set STRIPE_WEBHOOK_SECRET to the secret you typed when connecting Stripe");
    const t = Math.floor(Date.now() / 1000);
    headers["stripe-signature"] =
      `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  } else {
    const auth = flag("forged") ? "demo:forged" : arg("auth");
    if (!auth)
      throw new Error(
        "Pass --auth user:password (the Basic credentials set on the Chargebee webhook)",
      );
    headers.authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
  }
  const url = `${env().APP_URL}/api/integrations/${fixture.provider.toLowerCase()}/webhook/${integration.id}`;
  const res = await fetch(url, { method: "POST", headers, body: raw });
  console.log(
    `${fixture.provider} ${event} for ${fixture.account}${flag("forged") ? " (forged)" : ""}: HTTP ${res.status} ${await res.text()}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
