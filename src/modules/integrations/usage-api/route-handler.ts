import { logger } from "@/lib/logger";
import { receiveUsage } from "./receive";

/** The shared body of the three `/api/usage/v1/*` routes: Request in, Response out. */
export async function handleUsageRequest(req: Request, kind: "track" | "identify" | "batch") {
  if (Number(req.headers.get("content-length") ?? 0) > 1_000_000)
    return Response.json({ error: "too large" }, { status: 413 });
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const res = await receiveUsage(kind, { headers, rawBody, url: req.url });
    return Response.json(res.body, { status: res.status, headers: res.headers });
  } catch (error) {
    logger.error(
      { kind, err: error instanceof Error ? error.name : "unknown" },
      "usage intake failed",
    );
    return Response.json({ error: "error" }, { status: 500 });
  }
}
