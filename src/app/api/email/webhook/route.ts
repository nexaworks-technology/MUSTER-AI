import { NextResponse, type NextRequest } from "next/server";
import { processEmailWebhook, verifyWebhookSignature, type EmailWebhookEvent } from "@/modules/campaigns/service";

export async function POST(req: NextRequest) {
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  const rawBody = await req.text();

  const isValid = verifyWebhookSignature(
    {
      id: svixId,
      timestamp: svixTimestamp,
      signature: svixSignature,
    },
    rawBody,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  let event: EmailWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const result = await processEmailWebhook(event);
  return NextResponse.json({ received: true, ...result });
}
