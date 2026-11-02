import { env } from "@/lib/config/env";
import { createLogTransport } from "./logTransport";
import { createResendTransport } from "./resendTransport";
import type { EmailTransport, StaffEmail } from "./types";

/**
 * Staff email only — messages to our customer's own users (invitations). Email to *their*
 * customers goes exclusively through src/modules/outbound/dispatch.ts (M4, Rule 3), which owns
 * the separate, import-restricted customer transport.
 */
export type { StaffEmail } from "./types";

let transport: EmailTransport | undefined;

function staffTransport(): EmailTransport {
  if (transport) return transport;
  const e = env();
  transport =
    e.EMAIL_TRANSPORT === "resend"
      ? createResendTransport(e.RESEND_API_KEY!, e.EMAIL_FROM!)
      : createLogTransport();
  return transport;
}

export function sendStaffEmail(message: StaffEmail): Promise<{ id: string }> {
  return staffTransport().send(message);
}
