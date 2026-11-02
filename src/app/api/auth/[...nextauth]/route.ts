import type { NextRequest } from "next/server";
import { handlers, isGoogleConfigured } from "@/lib/auth/config";

/** Google routes exist only when Google sign-in is configured (env); otherwise 404. */
function googleUnavailable(req: NextRequest): boolean {
  return /\/(signin|callback)\/google\b/.test(req.nextUrl.pathname) && !isGoogleConfigured();
}

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(req: NextRequest) {
  return googleUnavailable(req) ? notFound() : handlers.GET(req);
}

export async function POST(req: NextRequest) {
  return googleUnavailable(req) ? notFound() : handlers.POST(req);
}
