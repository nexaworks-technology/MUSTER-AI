import type { Metadata } from "next";
import Link from "next/link";
import { ImportUpload } from "@/components/app/import-upload";
import { formatDateTime } from "@/lib/format";
import { listImports, TEMPLATES } from "@/modules/imports/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Import" };

const STATUS = {
  UPLOADED: "Uploaded",
  PREVIEWED: "Previewed",
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Stopped",
} as const;

export default async function ImportPage() {
  const ctx = await requireSettingsAccess("data:import");
  const imports = await listImports(ctx);
  const templates = Object.values(TEMPLATES);
  return (
    <div className="max-w-3xl space-y-6">
      <section aria-labelledby="start" className="space-y-3">
        <h2 id="start" className="text-base font-semibold">
          Import from CSV
        </h2>
        <p className="text-muted-foreground text-sm">
          Upload a file, match its columns, check the preview, then confirm. Nothing changes until
          you confirm, and importing the same file again creates no duplicates.
        </p>
        <ImportUpload templates={templates.map((t) => ({ kind: t.kind, title: t.title }))} />
      </section>
      <section aria-labelledby="templates" className="space-y-2">
        <h2 id="templates" className="text-base font-semibold">
          Templates
        </h2>
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {templates.map((t) => (
            <li key={t.kind} className="flex flex-wrap justify-between gap-2 p-2">
              <span>
                <span className="font-medium">{t.title}</span>{" "}
                <span className="text-muted-foreground">· {t.description}</span>
              </span>
              <a href={`/api/imports/templates/${t.slug}`} className="shrink-0 underline" download>
                Download {t.title.toLowerCase()} template
              </a>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="recent" className="space-y-2">
        <h2 id="recent" className="text-base font-semibold">
          Recent imports
        </h2>
        {imports.length === 0 ? (
          <p className="text-muted-foreground text-sm">No imports yet.</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-md border text-sm">
            {imports.map((j) => (
              <li key={j.id} className="flex flex-wrap justify-between gap-2 p-2">
                <Link href={`/settings/import/${j.id}`} className="underline">
                  {j.file.filename}
                </Link>
                <span className="text-muted-foreground">
                  {TEMPLATES[j.kind].title} · {STATUS[j.status]} ·{" "}
                  {formatDateTime(j.createdAt, ctx.workspace.timezone)}
                  {j.status === "COMPLETED"
                    ? ` · ${j.created} created, ${j.updated} updated, ${j.unchanged} unchanged, ${j.failed} failed`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
