import { templateBySlug, templateCsv } from "@/modules/imports/service";

/** GET /api/imports/templates/[slug] — the CSV template (header + one example row). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const template = templateBySlug((await params).slug);
  if (!template) return new Response("Template not found.", { status: 404 });
  return new Response(templateCsv(template), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${template.slug}-template.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
