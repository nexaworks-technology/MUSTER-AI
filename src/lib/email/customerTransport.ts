import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { logger } from "@/lib/logger";
import { postResendEmail } from "./resendHttp";

/**
 * The customer email transport (ARCHITECTURE §7.4, Rule 3). Only src/modules/outbound/dispatch.ts
 * may import this file (ESLint restricted import + import-graph test). In development and tests
 * it is log-only: the message is written to `.dev-mail/customer/` (git-ignored) and the log line
 * carries ids only, never the subject or body (Rule 8). Production uses Resend.
 */
export interface CustomerEmail {
  workspaceId: string;
  outboundMessageId: string;
  to: string;
  subject: string;
  text: string;
}

export interface CustomerTransport {
  readonly name: "log" | "resend";
  send(message: CustomerEmail): Promise<{ id: string }>;
}

export function createLogCustomerTransport(
  dir = path.join(process.cwd(), ".dev-mail", "customer"),
): CustomerTransport {
  return {
    name: "log",
    async send(message) {
      const id = `log-${randomUUID()}`;
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replaceAll(":", "-")}-${id}.json`);
      await writeFile(file, JSON.stringify({ id, transport: "log", ...message }, null, 2));
      logger.info(
        {
          emailId: id,
          outboundMessageId: message.outboundMessageId,
          workspaceId: message.workspaceId,
        },
        "customer email written to the dev log (log transport; nothing left this machine)",
      );
      return { id };
    },
  };
}

export function createResendCustomerTransport(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): CustomerTransport {
  return {
    name: "resend",
    send: (m) =>
      postResendEmail(
        apiKey,
        { from, to: m.to, subject: m.subject, text: m.text, idempotencyKey: m.outboundMessageId },
        fetchImpl,
      ),
  };
}

let transport: CustomerTransport | undefined;

export function customerTransport(): CustomerTransport {
  if (transport) return transport;
  const e = env();
  transport =
    e.EMAIL_TRANSPORT === "resend"
      ? createResendCustomerTransport(e.RESEND_API_KEY!, e.EMAIL_FROM!)
      : createLogCustomerTransport();
  return transport;
}
