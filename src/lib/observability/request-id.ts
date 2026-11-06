/**
 * Per-request correlation id (M12 B4). Pure and dependency-free so the proxy can use it.
 * An inbound id is trusted only when it is a short run of letters, digits and hyphens; anything
 * else (log-injection attempts, oversized values) is replaced by a fresh UUID.
 */
export const REQUEST_ID_HEADER = "x-request-id";

const ACCEPTED = /^[A-Za-z0-9-]{8,64}$/;

export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && ACCEPTED.test(inbound) ? inbound : crypto.randomUUID();
}
