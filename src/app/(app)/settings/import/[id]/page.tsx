import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmImport, MappingForm, RefreshWhileRunning } from "@/components/app/import-steps";
import { getImport, TEMPLATES } from "@/modules/imports/service";
import { requireSettingsAccess } from "../../access";

export const metadata: Metadata = { title: "Import" };

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSettingsAccess("data:import");
  const job = await getImport(ctx, (await params).id).catch(() => null);
  if (!job) notFound();
  const template = TEMPLATES[job.kind];
  const preview = job.report?.preview;
  const running = job.status === "QUEUED" || job.status === "RUNNING";
  const done = job.status === "COMPLETED" || job.status === "FAILED";
  return (
    <div className="max-w-3xl space-y-6">
      <RefreshWhileRunning running={running} />
      <div>
        <Link href="/settings/import" className="text-muted-foreground text-sm hover:underline">
          ← Imports
        </Link>
        <h2 className="mt-1 text-lg font-semibold">
          {template.title}: {job.file.filename}
        </h2>
        <p className="text-muted-foreground text-sm">
          {job.rowsTotal} rows · re-imports are matched on {template.dedupe}
        </p>
      </div>

      <section aria-labelledby="mapping" className="space-y-2">
        <h3 id="mapping" className="font-semibold">
          1. Match columns
        </h3>
        <MappingForm
          jobId={job.id}
          headers={job.headers}
          fields={template.fields.map((f) => ({
            key: f.key,
            label: f.label,
            required: f.required,
          }))}
          mapping={job.mapping}
          disabled={!["UPLOADED", "PREVIEWED"].includes(job.status)}
        />
      </section>

      {preview ? (
        <section aria-labelledby="preview" className="space-y-2" data-testid="import-preview">
          <h3 id="preview" className="font-semibold">
            2. Preview
          </h3>
          <p className="text-sm">
            {preview.create} to create · {preview.update} to update · {preview.unchanged} unchanged
            · {job.report?.totalErrors ?? 0} with problems (these rows will be skipped)
          </p>
          {job.report && job.report.errors.length > 0 ? (
            <ul
              className="border-border max-h-64 space-y-1 overflow-y-auto rounded-md border p-2 text-sm"
              tabIndex={0}
              aria-label="Rows with problems"
            >
              {job.report.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          ) : null}
          {job.status === "PREVIEWED" ? (
            <ConfirmImport
              jobId={job.id}
              label={`Confirm import of ${preview.create + preview.update} rows`}
            />
          ) : null}
        </section>
      ) : null}

      {running ? (
        <p role="status" className="text-sm">
          Importing… {job.created + job.updated + job.unchanged} rows done so far.
        </p>
      ) : null}

      {done ? (
        <section aria-labelledby="result" className="space-y-2" data-testid="import-result">
          <h3 id="result" className="font-semibold">
            3. Result
          </h3>
          {job.status === "FAILED" ? (
            <p role="alert" className="text-destructive text-sm">
              {job.errorPlain}
            </p>
          ) : null}
          <p className="text-sm" role="status">
            {job.created} created, {job.updated} updated, {job.unchanged} unchanged, {job.failed}{" "}
            failed.
          </p>
          {job.report && job.report.errors.length > 0 ? (
            <ul
              className="border-border max-h-64 space-y-1 overflow-y-auto rounded-md border p-2 text-sm"
              tabIndex={0}
              aria-label="Rows that were not imported"
            >
              {job.report.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
