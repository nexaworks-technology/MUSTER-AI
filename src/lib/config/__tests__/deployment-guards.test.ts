import { describe, expect, it } from "vitest";
import { testSeamsAllowed } from "../deployment";
import { parseEnv } from "../env";

/**
 * M12 B7 (D3, test-first): the production build runs e2e. The test-only seams (fake clock,
 * recorded AI, log email/Slack, fixture integrations, no-op scanner) are allowed in a production
 * build ONLY when APP_ENV=e2e AND the database name ends in `_e2e`. Every other production
 * build — APP_ENV unset, production, staging, or e2e pointed at any other database — keeps
 * every refusal.
 */
const DB = (name: string) => `postgresql://app_user:x@localhost:5432/${name}`;
const base = {
  AUTH_SECRET: "x".repeat(40),
  FIELD_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
  DATABASE_URL_MIGRATE: DB("nexaworks_dev"),
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
};
const seams = {
  AI_PROVIDER: "recorded",
  EMAIL_TRANSPORT: "log",
  SLACK_DELIVERY: "log",
  INTEGRATIONS_TRANSPORT: "fixture",
  ALLOW_FAKE_CLOCK: "true",
  APP_FAKE_NOW: "2026-11-02T17:00:00Z",
  RATE_LIMIT_SCALE: "50",
};

describe("testSeamsAllowed", () => {
  it("outside a production build, always", () => {
    expect(testSeamsAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(testSeamsAllowed({ NODE_ENV: "test" })).toBe(true);
  });
  it("in a production build only with APP_ENV=e2e on a *_e2e database", () => {
    expect(
      testSeamsAllowed({
        NODE_ENV: "production",
        APP_ENV: "e2e",
        DATABASE_URL: DB("nexaworks_e2e"),
      }),
    ).toBe(true);
    expect(
      testSeamsAllowed({
        NODE_ENV: "production",
        APP_ENV: "e2e",
        DATABASE_URL: DB("nexaworks_dev"),
      }),
    ).toBe(false);
    expect(
      testSeamsAllowed({
        NODE_ENV: "production",
        APP_ENV: "e2e",
        DATABASE_URL: DB("prod_e2e_backup?x=1"),
      }),
    ).toBe(false);
    expect(
      testSeamsAllowed({
        NODE_ENV: "production",
        APP_ENV: "staging",
        DATABASE_URL: DB("nexaworks_e2e"),
      }),
    ).toBe(false);
    expect(testSeamsAllowed({ NODE_ENV: "production", DATABASE_URL: DB("nexaworks_e2e") })).toBe(
      false,
    );
    expect(testSeamsAllowed({ NODE_ENV: "production", APP_ENV: "e2e" })).toBe(false);
  });
});

describe("production env refusals hold except for the e2e build", () => {
  // A real production configuration: live email and Slack, a malware scanner. It must parse
  // clean (control below), so each refusal is caused by the one seam under test and nothing else.
  const PROD = {
    ...base,
    NODE_ENV: "production",
    DATABASE_URL: DB("nexaworks"),
    EMAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "test-placeholder",
    EMAIL_FROM: "cs@example.com",
    SLACK_DELIVERY: "live",
    CLAMD_HOST: "clamd",
  };
  const parse = (extra: Record<string, string>) => () => parseEnv({ ...PROD, ...extra });

  it("control: the production configuration itself parses", () => {
    expect(parse({})).not.toThrow();
  });

  for (const [name, value] of Object.entries(seams).filter(([k]) => k !== "APP_FAKE_NOW")) {
    it(`refuses ${name}=${value} in production, staging and mis-pointed e2e`, () => {
      const one: Record<string, string> =
        name === "ALLOW_FAKE_CLOCK"
          ? { ALLOW_FAKE_CLOCK: "true", APP_FAKE_NOW: seams.APP_FAKE_NOW }
          : { [name]: value };
      const named = new RegExp(name);
      expect(parse(one)).toThrow(named);
      expect(parse({ ...one, APP_ENV: "staging" })).toThrow(named);
      expect(parse({ ...one, APP_ENV: "e2e" })).toThrow(named); // database not *_e2e
    });
  }

  it("refuses a production build with no malware scanner, unless it is the e2e build", () => {
    expect(() => parseEnv({ ...PROD, CLAMD_HOST: undefined })).toThrow(/malware scanner/);
    expect(() =>
      parseEnv({
        ...PROD,
        CLAMD_HOST: undefined,
        APP_ENV: "e2e",
        DATABASE_URL: DB("nexaworks_e2e"),
      }),
    ).not.toThrow();
  });

  it("allows every seam together for the e2e build on the e2e database", () => {
    expect(() =>
      parseEnv({
        ...base,
        ...seams,
        NODE_ENV: "production",
        APP_ENV: "e2e",
        DATABASE_URL: DB("nexaworks_e2e"),
      }),
    ).not.toThrow();
  });
});

describe("RATE_LIMIT_SCALE (e2e only)", () => {
  it("scales every limit only where test seams are allowed; 1 otherwise", async () => {
    const { scaledLimit } = await import("@/lib/rate-limit");
    const l = { limit: 5, windowSeconds: 600 };
    expect(scaledLimit(l, { RATE_LIMIT_SCALE: 50, seams: true })).toEqual({
      limit: 250,
      windowSeconds: 600,
    });
    expect(scaledLimit(l, { RATE_LIMIT_SCALE: undefined, seams: true })).toEqual(l);
    expect(scaledLimit(l, { RATE_LIMIT_SCALE: 50, seams: false })).toEqual(l);
  });
});
