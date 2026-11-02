import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";

const KEY = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const base = {
  DATABASE_URL: "postgresql://app_user:x@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(40),
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "s",
  FIELD_ENCRYPTION_KEY: KEY,
};

describe("env schema", () => {
  it("accepts a minimal development environment with safe defaults", () => {
    const env = parseEnv(base);
    expect(env.AI_PROVIDER).toBe("anthropic");
    expect(env.EMAIL_TRANSPORT).toBe("log");
    expect(env.AUTH_GOOGLE_ID).toBeUndefined();
  });

  it("names the missing variable without echoing any value", () => {
    const secret = "super-secret-value-that-must-not-leak";
    expect(() => parseEnv({ ...base, AUTH_SECRET: secret.slice(0, 5) })).toThrowError(
      /AUTH_SECRET/,
    );
    try {
      parseEnv({ ...base, AUTH_SECRET: "short", FIELD_ENCRYPTION_KEY: secret });
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
  });

  it("requires Google id and secret together", () => {
    expect(() => parseEnv({ ...base, AUTH_GOOGLE_ID: "x" })).toThrowError(/AUTH_GOOGLE_SECRET/);
  });

  it("refuses the recorded AI provider in production (D-19)", () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: "production",
        AI_PROVIDER: "recorded",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "x",
        EMAIL_FROM: "a@b.test",
      }),
    ).toThrowError(/recorded AI provider/);
  });

  it("refuses the log-only email transport in production", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrowError(/log-only/);
  });

  it("rejects a malformed encryption key", () => {
    expect(() => parseEnv({ ...base, FIELD_ENCRYPTION_KEY: "nope" })).toThrowError(
      /FIELD_ENCRYPTION_KEY/,
    );
  });
});
