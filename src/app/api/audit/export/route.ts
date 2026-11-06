import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { requestLogger } from "@/lib/logger/request";
import { exportAudit } from "@/modules/audit/service";

/**
 * GET /api/audit/export?format=csv|json&<filters> — the audit trail as a download (spec §6N2).
 * Admins only; the export itself is written to the audit trail.
 */
export async function GET(req: Request) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response("Sign in to export the audit log.", { status: 401 });
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const format = params.format === "json" ? "json" : "csv";
  try {
    const out = await exportAudit(ctx, params, format);
    return new Response(out.body, {
      headers: {
        "Content-Type": out.contentType,
        "Content-Disposition": `attachment; filename="${out.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError)
      return new Response("Only Admins can export the audit log.", { status: 403 });
    if (error instanceof Error && error.name === "ZodError")
      return new Response("Those filters are not valid.", { status: 400 });
    (await requestLogger()).error({ err: error }, "audit export failed");
    return new Response("The export failed.", { status: 500 });
  }
}
