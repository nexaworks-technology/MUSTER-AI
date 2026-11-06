import { clientIp } from "@/lib/http/client-ip";
import { LIMITS, limitOrRefuse } from "@/lib/http/guard";
import { requestLogger } from "@/lib/logger/request";
import { checkHealth, defaultHealthDeps } from "@/lib/observability/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health (M12 B4): 200 while the database and Redis answer, 503 when either does not.
 * A stale worker is reported in the body but does not fail the web health check. Unauthenticated
 * (the proxy only adds headers); limited per IP.
 */
export async function GET(req: Request) {
  const log = await requestLogger({ route: "/api/health" });
  try {
    const limited = await limitOrRefuse(`health:${clientIp(req.headers)}`, LIMITS.healthPerIp);
    if (limited) return limited;
  } catch {
    // Redis is down: the checks below report it; the limiter cannot count, so it does not block.
  }
  const report = await checkHealth(defaultHealthDeps);
  const status = report.status === "ok" ? 200 : 503;
  if (status !== 200) log.error({ db: report.db, redis: report.redis }, "health check failing");
  return Response.json(report, { status, headers: { "Cache-Control": "no-store" } });
}
