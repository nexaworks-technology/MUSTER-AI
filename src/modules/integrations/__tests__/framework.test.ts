import { readdirSync, readFileSync, statSync } from "node:fs";
import { Writable } from "node:stream";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "@/lib/config/env";
import { REDACT_PATHS } from "@/lib/logger";
import { openCredentials, sealCredentials, needsRefresh } from "../credentials";
import { describeProviderError } from "../errors";
import { createFixtureTransport, UnfixturedRequestError } from "../fixture-transport";
import { normalizedAccount, normalizedInvoice } from "../normalized";
import { ProviderHttpError, ProviderShapeError, requestJson, transportFor } from "../transport";

/** M5 framework core: transports, credentials at rest, plain errors, env and log safety. */
const KEY = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const baseEnv = {
  DATABASE_URL: "postgresql://app_user:x@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(40),
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "s",
  FIELD_ENCRYPTION_KEY: KEY,
};

describe("fixture transport (M5 rule 5)", () => {
  const t = () =>
    createFixtureTransport([
      {
        request: { method: "GET", path: "/v1/customers", query: { starting_after: "cus_2" } },
        response: { status: 200, headers: {}, body: { page: 2 } },
      },
      {
        request: { method: "GET", path: "/v1/customers" },
        response: { status: 200, headers: { "Retry-After": "3" }, body: { page: 1 } },
      },
    ]);

  it("answers the most specific recorded interaction first, ignoring the host", async () => {
    const tr = t();
    const page2 = await tr.request({
      method: "GET",
      url: "https://anything.example/v1/customers?limit=100&starting_after=cus_2",
    });
    const page1 = await tr.request({ method: "GET", url: "https://x.example/v1/customers" });
    expect(page2.body).toEqual({ page: 2 });
    expect(page1).toMatchObject({ body: { page: 1 }, headers: { "retry-after": "3" } });
    expect(tr.calls).toHaveLength(2);
  });

  it("refuses any request it has no fixture for, and records it", async () => {
    const tr = t();
    await expect(
      tr.request({ method: "POST", url: "https://api.stripe.com/v1/customers" }),
    ).rejects.toBeInstanceOf(UnfixturedRequestError);
    expect(tr.unmatched).toHaveLength(1);
  });

  it("transportFor never builds a live transport under NODE_ENV=test", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.INTEGRATIONS_TRANSPORT ?? "live").toBe("live");
    expect(() => transportFor("STRIPE")).toThrow(/Tests never call live services/);
  });

  it("no adapter or framework file calls fetch directly (only transport.ts may)", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__" && name !== "__fixtures__") walk(full);
        } else if (/\.tsx?$/.test(name) && full !== path.join(root, "transport.ts")) {
          if (/\bfetch\s*\(/.test(readFileSync(full, "utf8")))
            offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("requestJson", () => {
  it("throws ProviderHttpError with retry-after for non-2xx and ProviderShapeError for a bad body", async () => {
    const tr = createFixtureTransport([
      {
        request: { method: "GET", path: "/limited" },
        response: { status: 429, headers: { "retry-after": "30" }, body: {} },
      },
      {
        request: { method: "GET", path: "/odd" },
        response: { status: 200, headers: {}, body: { data: "not a list" } },
      },
    ]);
    const schema = z.object({ data: z.array(z.unknown()) });
    await expect(
      requestJson(tr, { method: "GET", url: "https://p.test/limited" }, schema),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 30 });
    await expect(
      requestJson(tr, { method: "GET", url: "https://p.test/odd" }, schema),
    ).rejects.toBeInstanceOf(ProviderShapeError);
  });
});

describe("describeError base: plain words, never a body or token", () => {
  const d = (e: unknown) => describeProviderError(e, "Chargebee", "Paste a new read-only key.");
  it.each([
    [401, /Chargebee rejected the saved credentials/],
    [403, /missing a permission/],
    [429, /slow down/],
    [503, /problem on its side \(HTTP 503\)/],
  ])("HTTP %i → plain sentence", (status, re) => {
    expect(d(new ProviderHttpError(status)).plain).toMatch(re);
  });
  it("tells the person what to do about a rejected key", () => {
    expect(d(new ProviderHttpError(401)).action).toBe("Paste a new read-only key.");
  });
  it("an unknown error says so without its message", () => {
    expect(d(new Error("sk_live_should_not_show")).plain).not.toContain("sk_live");
  });
});

describe("credentials at rest (Rule 9)", () => {
  it("seals to ciphertext that does not contain the token, and opens back", () => {
    const sealed = sealCredentials({ accessToken: "tok-visible-123", refreshToken: "ref-456" });
    expect(sealed).not.toContain("tok-visible-123");
    expect(sealed).not.toContain("ref-456");
    expect(openCredentials(sealed)).toEqual({
      accessToken: "tok-visible-123",
      refreshToken: "ref-456",
    });
    expect(openCredentials(null)).toEqual({});
  });
  it("needsRefresh: missing token, or expiring within a minute", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(needsRefresh({}, now)).toBe(true);
    expect(needsRefresh({ accessToken: "a" }, now)).toBe(false);
    expect(needsRefresh({ accessToken: "a", expiresAt: "2026-11-02T12:00:30Z" }, now)).toBe(true);
    expect(needsRefresh({ accessToken: "a", expiresAt: "2026-11-02T13:00:00Z" }, now)).toBe(false);
  });
});

describe("env and logs", () => {
  it("refuses the fixture transport in production and defaults to live", () => {
    expect(parseEnv(baseEnv).INTEGRATIONS_TRANSPORT).toBe("live");
    expect(() =>
      parseEnv({
        ...baseEnv,
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_x",
        EMAIL_FROM: "a@b.test",
        INTEGRATIONS_TRANSPORT: "fixture",
      }),
    ).toThrow(/INTEGRATIONS_TRANSPORT: the fixture integrations transport is test-only/);
  });

  it("the logger censors integration credentials at the top level and nested", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, sink);
    log.info({
      credentialsEnc: "k1.c1",
      apiKey: "sk_test_c2",
      accessToken: "c3",
      refreshToken: "c4",
      integration: { credentialsEnc: "k1.c5", webhookSecret: "c6", accessToken: "c7" },
      body: { client_secret: "c8" },
      integrationId: "visible-id",
    });
    const out = lines.join("");
    for (const s of ["k1.c1", "sk_test_c2", '"c3"', '"c4"', "k1.c5", '"c6"', '"c7"', '"c8"'])
      expect(out).not.toContain(s);
    expect(out).toContain("visible-id");
  });
});

describe("normalized schemas reject with plain reasons", () => {
  it("an account with no name or a bad domain is refused; domains are cleaned", () => {
    const r = normalizedAccount.safeParse({ externalId: "1", name: " " });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("has no name");
    expect(
      normalizedAccount.parse({
        externalId: "1",
        name: "Sundial",
        domain: "https://www.Sundial.fit/x",
      }).domain,
    ).toBe("sundial.fit");
    expect(
      normalizedAccount.safeParse({ externalId: "1", name: "S", domain: "not a domain" }).success,
    ).toBe(false);
  });
  it("invoice money is kept in minor units as BigInt", () => {
    const inv = normalizedInvoice.parse({
      externalId: "in_1",
      customerExternalId: "cus_1",
      number: "INV-1",
      amountMinor: "129900",
      currency: "usd",
      issuedAt: "2026-10-01T00:00:00Z",
      dueAt: "2026-10-15T00:00:00Z",
      status: "FAILED",
    });
    expect(inv.amountMinor).toBe(129900n);
    expect(inv.currency).toBe("USD");
  });
});
