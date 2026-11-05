import { NextResponse, type NextRequest } from "next/server";
import { buildSecurityHeaders, generateNonce } from "@/lib/security/headers";

/**
 * Next 16 "proxy" (formerly middleware). Adds the security headers to every response and hands
 * the per-request CSP nonce to Next through the request's CSP header (M12 A8).
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = buildSecurityHeaders({
    nonce: generateNonce(),
    production: process.env.NODE_ENV === "production",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  // Everything except static build assets; prefetches still get the headers.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
    },
  ],
};
