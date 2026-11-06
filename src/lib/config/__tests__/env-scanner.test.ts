import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";

const KEY = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const prod = {
  DATABASE_URL: "postgresql://app_user:x@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "a".repeat(40),
  S3_BUCKET: "b",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "s",
  FIELD_ENCRYPTION_KEY: KEY,
  NODE_ENV: "production",
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "x",
  EMAIL_FROM: "a@b.test",
  SLACK_DELIVERY: "live",
};

describe("production malware-scanner boot check (M12 #15, Q-18)", () => {
  it("refuses production with no CLAMD_* configured", () => {
    expect(() => parseEnv(prod)).toThrowError(/malware scanner.*CLAMD_HOST/s);
  });
  it("accepts CLAMD_HOST, or CLAMD_SOCKET", () => {
    expect(parseEnv({ ...prod, CLAMD_HOST: "clamav" }).CLAMD_PORT).toBe(3310);
    expect(parseEnv({ ...prod, CLAMD_SOCKET: "/run/clamd.sock" }).CLAMD_SOCKET).toBeDefined();
  });
  it("does not require a scanner in development", () => {
    const { NODE_ENV: _n, ...rest } = prod;
    expect(() => parseEnv(rest)).not.toThrow();
  });
  it("still refuses recorded AI in production even with a scanner", () => {
    expect(() => parseEnv({ ...prod, CLAMD_HOST: "c", AI_PROVIDER: "recorded" })).toThrowError(
      /recorded AI provider/,
    );
  });
});
