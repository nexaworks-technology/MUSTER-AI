import { formatDateTime } from "@/lib/format";
import { getExportLink, listExports, type ExportRow } from "@/modules/settings/service";
import type { WorkspaceContext } from "@/lib/auth/session";
import { ExportForm } from "./export-form";

const STATUS_TEXT: Record<ExportRow["status"], string> = {
  running: "Building",
  ready: "Ready",
  failed: "Failed",
  stalled: "Did not finish",
  expired: "Link expired",
};

const kb = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Admin-only export of everything in the workspace, as one ZIP behind a 7-day link. */
export async function ExportSection({ actor }: { actor: WorkspaceContext }) {
  const exports = await listExports(actor);
  const tz = actor.workspace.timezone;
  const links = new Map<string, string>();
  for (const e of exports.filter((x) => x.status === "ready").slice(0, 3))
    links.set(e.requestId, (await getExportLink(actor, e.requestId)).url);
  return (
    <section aria-labelledby="export" className="space-y-3">
      <h2 id="export" className="text-base font-semibold">
        Export all data
      </h2>
      <p className="text-muted-foreground text-sm">
        One ZIP with a JSON file for every kind of record in this workspace (accounts, contacts,
        contracts, signals, tasks, approvals, notes, audit history and the rest), a{" "}
        <code>files/</code> folder with the documents you uploaded, and a <code>manifest.json</code>{" "}
        that counts each kind of record and lists what was left out. It is built in the background
        and the download link works for 7 days.
      </p>
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
        <li>
          Money is included in full (ARR, contract values, invoices), whoever can see it in the app.
          Only Admins can export, and each export is written to the audit log.
        </li>
        <li>Contract terms and pricing notes are readable in the export; they are your data.</li>
        <li>
          Integration credentials, Usage API keys, invitation and portal link tokens, passwords and
          sign-in sessions are never exported. Reconnect integrations after any restore.
        </li>
        <li>
          Anyone with the link can download the file until it expires. Treat it as confidential.
        </li>
      </ul>
      <ExportForm disabled={exports.some((e) => e.status === "running")} />
      {exports.length === 0 ? (
        <p className="text-muted-foreground text-sm">No exports yet.</p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {exports.map((e) => (
            <li key={e.requestId} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>
                <span className="font-medium">{STATUS_TEXT[e.status]}</span>{" "}
                <span className="text-muted-foreground">
                  · requested {formatDateTime(e.requestedAt, tz)}
                  {e.bytes != null ? ` · ${kb(e.bytes)}, ${e.fileCount ?? 0} files` : ""}
                  {e.status === "ready" && e.expiresAt
                    ? ` · available until ${formatDateTime(e.expiresAt, tz)}`
                    : ""}
                </span>
              </span>
              {links.get(e.requestId) ? (
                <a href={links.get(e.requestId)} className="shrink-0 underline" download>
                  Download ZIP
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
