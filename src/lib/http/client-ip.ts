/**
 * The caller's IP for rate limiting (M12 A9). Behind Fly.io (D5) the edge sets `Fly-Client-IP`,
 * which a client cannot forge through the proxy; elsewhere the first `X-Forwarded-For` hop is
 * used, which is only trustworthy behind a proxy that overwrites it (documented in DEPLOY.md).
 */
export function clientIp(headers: Headers): string {
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}
