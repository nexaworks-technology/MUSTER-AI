/**
 * `pnpm demo:usage pinecrest [--key <ingest key>] [--url <app url>]`
 *
 * DEV-ONLY (refused in production, and for any address that is not this machine). Posts recorded
 * product events for a demo account to the RUNNING app's Usage API, the way a customer's backend
 * would: `POST /api/usage/v1/batch` with the ingest key as a Bearer token. The key is the one
 * shown once on Settings › Integrations › Usage API; pass it with --key or USAGE_API_KEY (it is
 * never printed). The events carry fixed message ids and no timestamps, so a second run is a
 * replay: the Usage API accepts it and the aggregation changes nothing (D-23, M6 B1).
 * Prints the HTTP answer only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/config/env";

const FIXTURES: Record<string, string> = { pinecrest: "fixtures/usage/pinecrest.json" };
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  if (env().NODE_ENV === "production") throw new Error("demo:usage is a development tool");
  const account = process.argv
    .slice(2)
    .find((a) => !a.startsWith("--") && a !== arg("key") && a !== arg("url"));
  const file = account ? FIXTURES[account] : undefined;
  if (!file)
    throw new Error(`usage: pnpm demo:usage ${Object.keys(FIXTURES).join(" | ")} [--key …]`);
  const key = arg("key") ?? process.env.USAGE_API_KEY;
  if (!key)
    throw new Error(
      "Pass the ingest key with --key or USAGE_API_KEY (generate one on Settings › Integrations › Usage API).",
    );
  const base = new URL(arg("url") ?? env().APP_URL);
  if (!LOCAL.has(base.hostname))
    throw new Error(`demo:usage only posts to this machine, not ${base.hostname}`);
  const body = readFileSync(path.join(process.cwd(), file), "utf8");
  const parsed = JSON.parse(body) as { batch: unknown[] };
  const res = await fetch(new URL("/api/usage/v1/batch", base), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ batch: parsed.batch }),
  });
  console.log(
    `usage batch for ${account} (${parsed.batch.length} events): HTTP ${res.status} ${await res.text()}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
