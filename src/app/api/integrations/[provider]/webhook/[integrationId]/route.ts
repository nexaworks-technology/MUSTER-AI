import { LIMITS, limitOrRefuse, openPublicRequest } from "@/lib/http/guard";
import { requestLogger } from "@/lib/logger/request";
import { providerParam, receiveWebhook } from "@/modules/integrations/service";

/**
 * POST /api/integrations/[provider]/webhook/[integrationId] — provider webhooks (M5 rule 4).
 * No session: the integration id in the URL names exactly one integration, and the payload is
 * applied only after its signature verifies with that integration's own secret. Bodies over
 * 1 MB are refused while streaming (M12 A9); repeated 401s block the caller's IP.
 */
const MAX_BODY = 1_000_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string; integrationId: string }> },
) {
  const { provider, integrationId } = await params;
  // M12 A9: blocked IPs refused, body read under a streaming cap, 401s counted per IP.
  const open = await openPublicRequest(req, MAX_BODY);
  if (open.refused) return open.refused;
  const parsed = providerParam.safeParse(provider);
  if (!parsed.success) return open.done(new Response("unverified", { status: 401 }));
  const limited = await limitOrRefuse(`webhook:${integrationId}`, LIMITS.webhookPerIntegration);
  if (limited) return limited;
  const rawBody = open.body;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  try {
    const res = await receiveWebhook(parsed.data, integrationId, {
      headers,
      rawBody,
      url: req.url,
    });
    return open.done(new Response(res.body, { status: res.status }));
  } catch (error) {
    (await requestLogger()).error(
      { provider, integrationId, err: error instanceof Error ? error.name : "unknown" },
      "webhook intake failed",
    );
    return new Response("error", { status: 500 });
  }
}
