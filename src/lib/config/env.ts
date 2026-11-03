import { z } from "zod";

/**
 * Server environment, validated once on first use (CLAUDE.md: Zod-parse every external input).
 * Parsing is lazy so `next build` does not need runtime secrets. Values are never logged (Rule 9);
 * validation errors name the variable, never its value.
 */
const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

/** `<keyId>:<base64 of 32 bytes>`, e.g. generated with `openssl rand -base64 32`. */
const encryptionKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,16}:[A-Za-z0-9+/]{43}=$/, "must be <keyId>:<base64 32-byte key>");

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),

    DATABASE_URL: z.url(),
    DATABASE_URL_MIGRATE: optionalString,
    REDIS_URL: z.url(),
    /** BullMQ key prefix. Default: "nexaworks", or "nexaworks-test" under NODE_ENV=test. */
    QUEUE_PREFIX: optionalString,
    /**
     * "off" stops the worker registering the per-workspace nightly health and signals schedules.
     * Unset or "on" (the default) is production behaviour. Only the e2e worker sets "off", so a
     * real-clock nightly run can never rewrite the seeded demo workspace (Q-49).
     */
    NIGHTLY_SCHEDULES: z.enum(["on", "off"]).default("on"),
    /**
     * TEST-ONLY fake business clock (Q-49, D-81). Honoured by businessClock only when
     * ALLOW_FAKE_CLOCK is exactly "true", APP_FAKE_NOW is an ISO 8601 instant, and NODE_ENV is not
     * production. Unset everywhere except the e2e harness.
     */
    ALLOW_FAKE_CLOCK: optionalString,
    APP_FAKE_NOW: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
        "must be an ISO 8601 instant",
      )
      .optional(),

    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    AUTH_GOOGLE_ID: optionalString,
    AUTH_GOOGLE_SECRET: optionalString,

    AI_PROVIDER: z.enum(["anthropic", "recorded"]).default("anthropic"),
    ANTHROPIC_API_KEY: optionalString,
    AI_MODEL_FAST: optionalString,
    AI_MODEL_STANDARD: optionalString,
    AI_MODEL_DEEP: optionalString,
    /** Where AI_PROVIDER=recorded reads recordings (default prompts/__recordings__). Tests/demo only. */
    AI_RECORDINGS_DIR: optionalString,

    EMAIL_TRANSPORT: z.enum(["log", "resend"]).default("log"),
    EMAIL_FROM: optionalString,
    RESEND_API_KEY: optionalString,

    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    FIELD_ENCRYPTION_KEY: encryptionKey,

    /**
     * How connectors reach providers (M5, D-85). "live" = HTTPS to the provider. "fixture" =
     * recorded payloads from the adapters' __fixtures__ folders, for tests, e2e and the demo only;
     * refused in production. Any request with no recorded fixture fails loudly.
     */
    INTEGRATIONS_TRANSPORT: z.enum(["live", "fixture"]).default("live"),
    HUBSPOT_CLIENT_ID: optionalString,
    HUBSPOT_CLIENT_SECRET: optionalString,
    SALESFORCE_CLIENT_ID: optionalString,
    SALESFORCE_CLIENT_SECRET: optionalString,
    SLACK_CLIENT_ID: optionalString,
    SLACK_CLIENT_SECRET: optionalString,
    SLACK_SIGNING_SECRET: optionalString,
    /**
     * How Slack messages leave (D4, D-95): "log" writes them to `.dev-slack/` (development, test,
     * e2e, demo); "live" posts with the workspace's bot token. "log" is refused in production.
     */
    SLACK_DELIVERY: z.enum(["log", "live"]).default("log"),
    /** Used only by the dev `pnpm demo:webhook` script; real integrations keep their own (D3). */
    STRIPE_WEBHOOK_SECRET: optionalString,

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.AUTH_GOOGLE_ID) !== Boolean(env.AUTH_GOOGLE_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_GOOGLE_SECRET"],
        message: "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set together",
      });
    }
    if (env.AI_PROVIDER === "recorded" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message: "the recorded AI provider is test-only and refused in production (D-19)",
      });
    }
    if (env.EMAIL_TRANSPORT === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "EMAIL_TRANSPORT=resend needs RESEND_API_KEY and EMAIL_FROM",
      });
    }
    if (env.NODE_ENV === "production" && env.INTEGRATIONS_TRANSPORT === "fixture") {
      ctx.addIssue({
        code: "custom",
        path: ["INTEGRATIONS_TRANSPORT"],
        message: "the fixture integrations transport is test-only and refused in production",
      });
    }
    if (env.NODE_ENV === "production" && env.SLACK_DELIVERY === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["SLACK_DELIVERY"],
        message: "the log-only Slack delivery is for development and test only",
      });
    }
    if (env.NODE_ENV === "production" && env.EMAIL_TRANSPORT === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: "the log-only email transport is for development and test only",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Format issues as "NAME: message" lines — names only, never values (Rule 9). */
export function describeEnvIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${describeEnvIssues(result.error)}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
