import type { Instrumentation } from "next";

/**
 * Next hook for server errors (M12 B4, Q-20). Logs one structured line and hands the error to the
 * optional tracker, which sends error shape only: never the message, request, headers or cookies.
 * `request.path` is deliberately not used: it carries the query string.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const requestIdHeader = request.headers["x-request-id"];
  const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
  const { logger } = await import("@/lib/logger");
  const { captureError } = await import("@/lib/observability/error-tracking");
  logger.error(
    { requestId, route: context.routePath, routeType: context.routeType, err },
    "request failed",
  );
  await captureError(err, { requestId, route: context.routePath });
};
