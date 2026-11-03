import { z } from "zod";

/**
 * One call to the Resend HTTP API. Used only by the customer transport (the import-graph test
 * pins its importers). The key comes from env and is never logged; the body is never logged.
 */
const resendResponse = z.object({ id: z.string().min(1) });

export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Resend's idempotency header: one outbound message can never be delivered twice. */
  idempotencyKey: string;
}

export async function postResendEmail(
  apiKey: string,
  message: ResendMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });
  if (!res.ok) throw new Error(`Email provider rejected the message (HTTP ${res.status})`);
  return resendResponse.parse(await res.json());
}
