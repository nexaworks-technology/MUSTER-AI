import { testSeamsAllowed } from "./deployment";
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
    /** What the deployment is for (M12 B7, D-182); unset = production behaviour for a production build. */
    APP_ENV: z.enum(["production", "staging", "e2e", "development", "test"]).optional(),
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
    /**
     * D-116: live write-back to a customer's CRM stays refused in code until this is "true". It does
     * not affect fixture transports. Unset by default; live verification belongs to M12.
     */
    WRITE_BACK_LIVE: z.enum(["true", "false"]).default("false"),
    HUBSPOT_CLIENT_ID: optionalString,
    HUBSPOT_CLIENT_SECRET: optionalString,
    SALESFORCE_CLIENT_ID: optionalString,
    SALESFORCE_CLIENT_SECRET: optionalString,
    SLACK_CLIENT_ID: optionalString,
    SLACK_CLIENT_SECRET: optionalString,
    SLACK_SIGNING_SECRET: optionalString,
    GOOGLE_EMAIL_CLIENT_ID: optionalString,
    GOOGLE_EMAIL_CLIENT_SECRET: optionalString,
    MICROSOFT_EMAIL_CLIENT_ID: optionalString,
    MICROSOFT_EMAIL_CLIENT_SECRET: optionalString,
    GOOGLE_CALENDAR_CLIENT_ID: optionalString,
    GOOGLE_CALENDAR_CLIENT_SECRET: optionalString,
    MICROSOFT_CALENDAR_CLIENT_ID: optionalString,
    MICROSOFT_CALENDAR_CLIENT_SECRET: optionalString,
    ZOOM_CLIENT_ID: optionalString,
    ZOOM_CLIENT_SECRET: optionalString,
    /**
     * Resend delivery webhook (bounces, complaints): the Svix signing secret (`whsec_…`) shown when
     * the webhook is added in Resend. Unset = every delivery event is refused with 401.
     */
    RESEND_WEBHOOK_SECRET: optionalString,
    /**
     * How Slack messages leave (D4, D-95): "log" writes them to `.dev-slack/` (development, test,
     * e2e, demo); "live" posts with the workspace's bot token. "log" is refused in production.
     */
    SLACK_DELIVERY: z.enum(["log", "live"]).default("log"),
    /**
     * M12 B7 (D-182): e2e only. Multiplies every request rate limit, because the whole e2e suite signs
     * in from one address. Refused wherever test seams are not allowed (production, staging).
     */
    RATE_LIMIT_SCALE: z.coerce.number().int().min(1).max(1000).optional(),
    /** Used only by the dev `pnpm demo:webhook` script; real integrations keep their own (D3). */
    STRIPE_WEBHOOK_SECRET: optionalString,

    /** ClamAV daemon for upload scanning (Q-18). Production needs CLAMD_HOST or CLAMD_SOCKET. */
    CLAMD_HOST: optionalString,
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    CLAMD_SOCKET: optionalString,
    CLAMD_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),

    /**
     * Optional error tracking (M12 B4, Q-20): a Sentry-compatible DSN (`https://<key>@<host>/<id>`).
     * Unset = no tracking. Only error shape is ever sent (src/lib/observability/error-tracking.ts).
     */
    ERROR_TRACKING_DSN: optionalString.refine(
      (v) => v === undefined || /^https?:\/\/[^/@\s]+@[^/\s]+\/(?:[^/\s]+\/)*\d+\/?$/.test(v),
      "must look like https://<key>@<host>/<projectId>",
    ),
    /** Release / commit id shown by /api/health and attached to tracked errors. Optional. */
    APP_RELEASE: optionalString,

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .superRefine((env, ctx) => {
    // M12 B7: one rule for every test seam (D-182) — production builds refuse them all except the
    // end-to-end build on an *_e2e database.
    const seams = testSeamsAllowed({
      NODE_ENV: env.NODE_ENV,
      APP_ENV: env.APP_ENV,
      DATABASE_URL: env.DATABASE_URL,
    });
    if (!seams && env.ALLOW_FAKE_CLOCK === "true") {
      ctx.addIssue({
        code: "custom",
        path: ["ALLOW_FAKE_CLOCK"],
        message: "the fake business clock is test-only and refused in production",
      });
    }
    if (Boolean(env.AUTH_GOOGLE_ID) !== Boolean(env.AUTH_GOOGLE_SECRET)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_GOOGLE_SECRET"],
        message: "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set together",
      });
    }
    if (env.AI_PROVIDER === "recorded" && !seams) {
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message: "the recorded AI provider is test-only and refused in production (D-19)",
      });
    }
    if (!seams && !env.CLAMD_HOST && !env.CLAMD_SOCKET) {
      ctx.addIssue({
        code: "custom",
        path: ["CLAMD_HOST"],
        message:
          "production needs a malware scanner (ClamAV clamd): set CLAMD_HOST (and CLAMD_PORT) or CLAMD_SOCKET (Q-18)",
      });
    }
    if (env.EMAIL_TRANSPORT === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "EMAIL_TRANSPORT=resend needs RESEND_API_KEY and EMAIL_FROM",
      });
    }
    if (!seams && env.INTEGRATIONS_TRANSPORT === "fixture") {
      ctx.addIssue({
        code: "custom",
        path: ["INTEGRATIONS_TRANSPORT"],
        message: "the fixture integrations transport is test-only and refused in production",
      });
    }
    if (!seams && env.SLACK_DELIVERY === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["SLACK_DELIVERY"],
        message: "the log-only Slack delivery is for development and test only",
      });
    }
    if (!seams && env.RATE_LIMIT_SCALE !== undefined && env.RATE_LIMIT_SCALE !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_SCALE"],
        message: "scaled rate limits are for the end-to-end build only",
      });
    }
    if (!seams && env.EMAIL_TRANSPORT === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: "the log-only email transport is for development and test only",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Every connector variable (CONNECTOR-LIVE.md). docker-compose.yml forwards each one to both `web`
 * and `worker`, and .env.example lists each; a test keeps the three in step.
 */
export const CONNECTOR_ENV_NAMES: readonly string[] = [
  "INTEGRATIONS_TRANSPORT",
  "WRITE_BACK_LIVE",
  "HUBSPOT_CLIENT_ID",
  "HUBSPOT_CLIENT_SECRET",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "GOOGLE_EMAIL_CLIENT_ID",
  "GOOGLE_EMAIL_CLIENT_SECRET",
  "MICROSOFT_EMAIL_CLIENT_ID",
  "MICROSOFT_EMAIL_CLIENT_SECRET",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MICROSOFT_CALENDAR_CLIENT_ID",
  "MICROSOFT_CALENDAR_CLIENT_SECRET",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
  "RESEND_WEBHOOK_SECRET",
];

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
