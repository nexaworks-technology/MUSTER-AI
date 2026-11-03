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
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: process.env.NEXAWORKS_PROCESS ?? "web" },
});
