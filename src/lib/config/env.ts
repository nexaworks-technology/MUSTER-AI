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

    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    AUTH_GOOGLE_ID: optionalString,
    AUTH_GOOGLE_SECRET: optionalString,

    AI_PROVIDER: z.enum(["anthropic", "recorded"]).default("anthropic"),
    ANTHROPIC_API_KEY: optionalString,
    AI_MODEL_FAST: optionalString,
    AI_MODEL_STANDARD: optionalString,
    AI_MODEL_DEEP: optionalString,

    EMAIL_TRANSPORT: z.enum(["log", "resend"]).default("log"),
    EMAIL_FROM: optionalString,
    RESEND_API_KEY: optionalString,

    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    FIELD_ENCRYPTION_KEY: encryptionKey,

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
