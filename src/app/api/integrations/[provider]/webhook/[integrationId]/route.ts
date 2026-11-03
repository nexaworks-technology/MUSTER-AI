import { logger } from "@/lib/logger";
import { providerParam, receiveWebhook } from "@/modules/integrations/service";

/**
 * POST /api/integrations/[provider]/webhook/[integrationId] — provider webhooks (M5 rule 4).
 * No session: the integration id in the URL names exactly one integration, and the payload is
 * applied only after its signature verifies with that integration's own secret. Bodies over
 * 1 MB are refused unread.
 */
const MAX_BODY = 1_000_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string; integrationId: string }> },
) {
  const { provider, integrationId } = await params;
  const parsed = providerParam.safeParse(provider);
  if (!parsed.success) return new Response("unverified", { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
    return new Response("too large", { status: 413 });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return new Response("too large", { status: 413 });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const res = await receiveWebhook(parsed.data, integrationId, {
      headers,
      rawBody,
      url: req.url,
    });
    return new Response(res.body, { status: res.status });
  } catch (error) {
    logger.error(
      { provider, integrationId, err: error instanceof Error ? error.name : "unknown" },
      "webhook intake failed",
    );
    return new Response("error", { status: 500 });
  }
}
