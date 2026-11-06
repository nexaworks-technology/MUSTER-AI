import { NextResponse } from "next/server";
import { openPublicRequest } from "@/lib/http/guard";
import { logger } from "@/lib/logger";
import { handleSlackInteraction } from "@/modules/integrations/service";

/**
 * POST /api/integrations/slack/interactivity — Approve / Reject clicks from Slack (Q-31, D-95).
 * The Slack signing secret and a 5-minute timestamp window are checked before anything is read;
 * the decision then runs as the linked member through the approvals service, like the web UI.
 */
const MAX_BODY = 200_000;

export async function POST(req: Request) {
  // M12 A9: blocked IPs refused, body read under a streaming cap, 401s counted per IP.
  const open = await openPublicRequest(req, MAX_BODY);
  if (open.refused) return open.refused;
  const rawBody = open.body;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const r = await handleSlackInteraction({ headers, rawBody });
    return open.done(
      typeof r.body === "string"
        ? new Response(r.body, { status: r.status })
        : NextResponse.json(r.body, { status: r.status }),
    );
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.name : "unknown" },
      "slack interaction failed",
    );
    return NextResponse.json(
      { response_type: "ephemeral", text: "Something went wrong; nothing was decided." },
      { status: 200 },
    );
  }
}
