import { headers } from "next/headers";
import type { Logger } from "pino";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { logger } from "./index";

/**
 * A child logger carrying the request id the proxy set (M12 B4). For route handlers and Server
 * Actions; outside a request (no headers) it returns the plain logger.
 */
export async function requestLogger(
  bindings: Record<string, unknown> = {},
  base: Logger = logger,
): Promise<Logger> {
  const requestId = await currentRequestId();
  return base.child(requestId ? { requestId, ...bindings } : bindings);
}

export async function currentRequestId(): Promise<string | undefined> {
  try {
    return (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
  } catch {
    return undefined; // not inside a request
  }
}
