import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECTOR_ENV_NAMES, envSchema } from "../env";

/**
 * Connector env reaches every runtime (CONNECTOR-LIVE.md common blocker 1, Resend blocker 2).
 * docker-compose.yml lists each service's environment explicitly, so a connector variable that is
 * not forwarded there silently does not exist in the Docker web/worker containers, and every OAuth
 * connect fails. These checks read the real files; names only, never values.
 */
const ROOT = process.cwd();
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const schemaKeys = Object.keys(envSchema.shape);

/** The `environment:` block of one compose service, as text. */
function serviceEnvironment(service: string): string {
  const compose = read("docker-compose.yml");
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start, `service ${service} in docker-compose.yml`).toBeGreaterThan(-1);
  const rest = compose.slice(start + service.length + 5);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  const block = next === -1 ? rest : rest.slice(0, next);
  const env = block.indexOf("    environment:\n");
  expect(env, `${service} has an environment block`).toBeGreaterThan(-1);
  const body = block.slice(env + "    environment:\n".length);
  const end = body.search(/\n {4}[a-z_]+:/);
  return end === -1 ? body : body.slice(0, end);
}

/** Every `process.env.NAME` read under a directory (or in one file). */
function envReads(rel: string): Set<string> {
  const out = new Set<string>();
  const walk = (abs: string) => {
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs)) if (f !== "__tests__") walk(path.join(abs, f));
      return;
    }
    if (!/\.tsx?$/.test(abs)) return;
    for (const m of readFileSync(abs, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
      out.add(m[1]!);
  };
  walk(path.join(ROOT, rel));
  return out;
}

/** Older alternative names some adapters also accept; documented names are the ones above. */
const LEGACY_ALIASES = new Set([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "EMAIL_WEBHOOK_SECRET",
]);

describe("connector environment variables", () => {
  it("lists every connector name the schema defines", () => {
    const connectorLike = schemaKeys.filter(
      (k) =>
        /_CLIENT_(ID|SECRET)$|_SIGNING_SECRET$|_WEBHOOK_SECRET$/.test(k) ||
        k === "WRITE_BACK_LIVE" ||
        k === "INTEGRATIONS_TRANSPORT",
    );
    // Not connectors: Google sign-in, and the dev-only demo:webhook secret.
    const notConnectors = new Set(["STRIPE_WEBHOOK_SECRET"]);
    expect([...CONNECTOR_ENV_NAMES].sort()).toEqual(
      connectorLike.filter((k) => !notConnectors.has(k)).sort(),
    );
  });

  it("defines every connector name in the env schema and in .env.example", () => {
    const example = read(".env.example");
    for (const name of CONNECTOR_ENV_NAMES) {
      expect(schemaKeys, `${name} in envSchema`).toContain(name);
      expect(example, `${name} in .env.example`).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });

  it("puts RESEND_WEBHOOK_SECRET in the schema, .env.example and the connector list", () => {
    expect(schemaKeys).toContain("RESEND_WEBHOOK_SECRET");
    expect(read(".env.example")).toMatch(/^RESEND_WEBHOOK_SECRET=$/m);
    expect(CONNECTOR_ENV_NAMES).toContain("RESEND_WEBHOOK_SECRET");
  });

  it.each(["web", "worker"])("docker-compose forwards every connector name to %s", (service) => {
    const block = serviceEnvironment(service);
    for (const name of CONNECTOR_ENV_NAMES)
      expect(block, `${service} forwards ${name}`).toMatch(
        new RegExp(`^ {6}${name}: \\$\\{${name}(:-[^}]*)?\\}$`, "m"),
      );
  });

  it("documents every connector variable that integration code reads directly", () => {
    const reads = new Set([
      ...envReads("src/modules/integrations"),
      ...envReads("src/modules/campaigns/webhook.ts"),
    ]);
    const generic = new Set(["NODE_ENV", "DATABASE_URL", "DATABASE_URL_MIGRATE"]);
    const undocumented = [...reads].filter(
      (n) => !generic.has(n) && !LEGACY_ALIASES.has(n) && !CONNECTOR_ENV_NAMES.includes(n),
    );
    expect(undocumented).toEqual([]);
  });

  it("accepts the new names as optional strings and never requires them", () => {
    const base = {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      AUTH_SECRET: "a".repeat(40),
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "s",
      FIELD_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
    };
    expect(envSchema.safeParse(base).success).toBe(true);
    const parsed = envSchema.parse({
      ...base,
      RESEND_WEBHOOK_SECRET: "whsec_x",
      ZOOM_CLIENT_ID: "",
    });
    expect(parsed.RESEND_WEBHOOK_SECRET).toBe("whsec_x");
    expect(parsed.ZOOM_CLIENT_ID).toBeUndefined();
  });
});
