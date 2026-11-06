import { NextResponse, type NextRequest } from "next/server";
import { openPublicRequest } from "@/lib/http/guard";
import {
  parseEmailWebhookEvent,
  processEmailWebhook,
  verifyWebhookSignature,
} from "@/modules/campaigns/service";

/** M12 A9: provider delivery webhooks are small; 256 KB, read under a streaming cap. */
const MAX_BODY = 256_000;

export async function POST(req: NextRequest) {
  const open = await openPublicRequest(req, MAX_BODY);
  if (open.refused) return open.refused;
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  const rawBody = open.body;

  const isValid = verifyWebhookSignature(
    {
      id: svixId,
      timestamp: svixTimestamp,
      signature: svixSignature,
    },
    rawBody,
  );

  if (!isValid) {
    return open.done(NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 }));
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  const event = parseEmailWebhookEvent(json);
  if (!event) return NextResponse.json({ error: "Not a delivery event" }, { status: 400 });

  const result = await processEmailWebhook(event);
  return NextResponse.json({ received: true, ...result });
}
