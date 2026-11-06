import { headers } from "next/headers";
import type { RateLimit } from "@/lib/rate-limit";
import { clientIp } from "./client-ip";
import { guardAuthFailures, limitOrRefuse, noteAuthFailure } from "./guard";

/**
 * Rate limits for Server Actions (M12 A9). Actions return state rather than a status code, so a
 * refusal is a plain sentence the form shows; the counting is the same Redis window as the routes.
 */
export const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";

export async function actionIp(): Promise<string> {
  return clientIp(await headers());
}

/** null when allowed; TOO_MANY when the IP is blocked or any key is over its limit. */
export async function refuseAction(
  ip: string,
  keys: Array<[string, RateLimit]>,
): Promise<string | null> {
  if (await guardAuthFailures(ip)) return TOO_MANY;
  for (const [key, limit] of keys) if (await limitOrRefuse(key, limit)) return TOO_MANY;
  return null;
}

export { noteAuthFailure };

/**
 * Token pages (customer portal, survey link): limited per IP, and an invalid or expired token
 * counts as an authentication failure against the IP (M12 A9). `refused` means show the refusal.
 */
export async function openTokenPage(
  kind: "portal" | "survey",
  limit: RateLimit,
): Promise<{ ip: string; refused: boolean }> {
  const ip = await actionIp();
  return { ip, refused: (await refuseAction(ip, [[`${kind}:ip:${ip}`, limit]])) !== null };
}
