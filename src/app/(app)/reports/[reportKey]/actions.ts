"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import {
  filtersQuery,
  generateInput,
  generateReport,
  normalizeFilters,
  ReportFilterError,
} from "@/modules/reports/service";

/**
 * Generate: stores a MANUAL snapshot for these filters and goes back to the report. Input is
 * Zod-parsed; the permission and the viewer's book are checked in the service, never here.
 */
export async function generateReportAction(formData: FormData): Promise<void> {
  const field = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const raw = {
    reportKey: field("reportKey"),
    filters: {
      periodDays: field("periodDays"),
      start: field("start"),
      end: field("end"),
      owner: field("owner"),
      tier: field("tier"),
      segment: field("segment"),
    },
  };
  const back = (key: string, query: string, error?: string): never =>
    redirect(
      `/reports/${encodeURIComponent(key)}?${[
        query,
        error ? `error=${encodeURIComponent(error)}` : "",
      ]
        .filter(Boolean)
        .join("&")}` as never,
    );

  const parsed = generateInput.safeParse(raw);
  if (!parsed.success) {
    const key = z.string().safeParse(raw.reportKey).data ?? "";
    return back(key, "", parsed.error.issues[0]?.message ?? "Those filters are not valid.");
  }
  const { reportKey, filters } = parsed.data;
  const query = filtersQuery(normalizeFilters(filters));
  try {
    const actor = await resolveWorkspaceContext(await requireSession());
    if (!actor) return back(reportKey, query, "You're not a member of this workspace.");
    await generateReport(actor, reportKey, filters, "MANUAL");
  } catch (error) {
    if (error instanceof ReportFilterError) return back(reportKey, query, error.message);
    if (error instanceof ForbiddenError)
      return back(reportKey, query, "You don't have permission to generate reports.");
    logger.error({ err: error }, "report generation failed");
    return back(reportKey, query, "The report was not generated. Try again.");
  }
  revalidatePath(`/reports/${reportKey}`);
  revalidatePath("/reports");
  return back(reportKey, query);
}
