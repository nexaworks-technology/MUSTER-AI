import { NextResponse, type NextRequest } from "next/server";
import { processUnsubscribe } from "@/modules/campaigns/service";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const result = await processUnsubscribe(token);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true, email: result.email });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const token = body.token || req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const result = await processUnsubscribe(token);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true, email: result.email });
}
