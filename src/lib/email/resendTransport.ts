import { z } from "zod";
import type { EmailTransport, StaffEmail } from "./types";

/** Production transport for staff email via the Resend HTTP API. Key comes from env only. */
const resendResponse = z.object({ id: z.string() });

export function createResendTransport(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    name: "resend",
    async send(message: StaffEmail) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
      if (!res.ok) throw new Error(`Email provider rejected the message (HTTP ${res.status})`);
      return resendResponse.parse(await res.json());
    },
  };
}
