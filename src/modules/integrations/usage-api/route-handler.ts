import { openPublicRequest } from "@/lib/http/guard";
import { logger } from "@/lib/logger";
import { receiveUsage } from "./receive";

/** The shared body of the three `/api/usage/v1/*` routes: Request in, Response out. */
export async function handleUsageRequest(req: Request, kind: "track" | "identify" | "batch") {
  // M12 A9: blocked IPs refused, body read under a streaming cap, 401s counted per IP.
  const open = await openPublicRequest(req, 1_000_000);
  if (open.refused) return open.refused;
  const rawBody = open.body;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const res = await receiveUsage(kind, { headers, rawBody, url: req.url });
    return open.done(Response.json(res.body, { status: res.status, headers: res.headers }));
  } catch (error) {
    logger.error(
      { kind, err: error instanceof Error ? error.name : "unknown" },
      "usage intake failed",
    );
    return Response.json({ error: "error" }, { status: 500 });
  }
}
