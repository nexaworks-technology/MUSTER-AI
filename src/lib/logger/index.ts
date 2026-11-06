import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

/**
 * Structured logger with redaction (ARCHITECTURE §7.5, Rule 9). Never log secrets, email bodies
 * or AI request/response content — ids, counts and timings only.
 */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "*.sessionToken",
  "sessionToken",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "headers.cookie",
  "*.credentialsEnc",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.apiKey",
  "*.secret",
  "credentialsEnc",
  "apiKey",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "webhookSecret",
  "*.webhookSecret",
  "*.client_secret",
  "*.signingSecret",
  "*.bodyText",
  "*.bodyHtml",
  "cookie",
  "*.cookie",
  'headers["set-cookie"]',
  'headers["x-api-key"]',
  "req.headers.authorization",
  "req.headers.cookie",
  "email",
  "*.email",
  "RESEND_API_KEY",
  "*.RESEND_API_KEY",
  "ERROR_TRACKING_DSN",
  "*.ERROR_TRACKING_DSN",
  "secret",
];

/**
 * Key names (compared lower-case with `-`/`_` removed) whose value is never logged, at any depth,
 * in arrays and inside Error objects. Covers secrets (Rule 9) and customer / AI content (Rule 8).
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authorization",
  "cookie",
  "setcookie",
  "credentialsenc",
  "apikey",
  "secret",
  "clientsecret",
  "signingsecret",
  "webhooksecret",
  "anthropicapikey",
  "xapikey",
  "privatekey",
  "resendapikey",
  "errortrackingdsn",
  "dsn",
  "email",
  "bodytext",
  "bodyhtml",
  "body",
  "output",
  "answer",
  "prompt",
  "system",
  "input",
]);

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g, "[REDACTED]"],
  [/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]"],
  // Email addresses in free text (Rule 8): the log keeps ids, never who someone is.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
  [/(x-api-key\s*[:=]\s*)[^\s"',;]+/gi, "$1[REDACTED]"],
];

const MAX_DEPTH = 8;

function scrubString(value: string): string {
  return VALUE_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** Deep, cycle-safe copy of `value` with sensitive keys censored and key-shaped strings scrubbed. */
export function scrubForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubForLog(v, depth + 1, seen));
  const source: Record<string, unknown> =
    value instanceof Error
      ? {
          ...(value as unknown as Record<string, unknown>),
          type: value.name,
          message: value.message,
          stack: value.stack,
          ...("cause" in value ? { cause: value.cause } : {}),
        }
      : (value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = isSensitiveKey(k) ? "[REDACTED]" : scrubForLog(v, depth + 1, seen);
  }
  return out;
}

/** Identifies one background job; every line logged while it runs carries it (M12 B4). */
export interface JobContext {
  jobId: string;
  queue: string;
  job: string;
}

const jobContext = new AsyncLocalStorage<JobContext>();

/** Runs `fn` so that every log line written inside it (any logger) carries the job's identity. */
export function runWithJobContext<T>(ctx: JobContext, fn: () => T): T {
  return jobContext.run(ctx, fn);
}

/** A child logger bound to one job, for code that holds the job explicitly. */
export function jobLogger(ctx: JobContext, base: pino.Logger = logger): pino.Logger {
  return base.child(ctx);
}

export function createLogger(destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: process.env.NEXAWORKS_PROCESS ?? "web" },
    mixin: () => jobContext.getStore() ?? {},
    hooks: {
      // Every argument is deep-scrubbed before pino serialises it; the redact paths above stay as
      // a second layer for the fixed shapes.
      logMethod(args, method) {
        const scrubbed = args.map((a) => scrubForLog(a)) as unknown as Parameters<typeof method>;
        if (args[0] instanceof Error) {
          const err = scrubbed[0] as { message?: string };
          scrubbed.splice(
            0,
            1,
            { err } as never,
            ...(typeof args[1] === "string" ? [] : [err.message as never]),
          );
        }
        method.apply(this, scrubbed);
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
