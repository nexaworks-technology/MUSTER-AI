import type { Metadata, Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { formatDateTime } from "@/lib/format";
import { auditQuery, listAudit } from "@/modules/audit/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Audit" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Settings › Audit (spec §6N2): every human and AI decision, filterable and exportable. */
export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireSettingsAccess("audit:view");
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = auditQuery.safeParse(raw);
  const page = await listAudit(ctx, parsed.success ? raw : {});
  const canExport = Boolean(can(ctx, "audit:export"));
  const filters = Object.fromEntries(
    Object.entries(page.query).filter(([k, v]) => k !== "cursor" && v !== undefined && v !== ""),
  ) as Record<string, string>;
  const qs = (extra: Record<string, string>) =>
    new URLSearchParams({ ...filters, ...extra }).toString();
  const field = "border-input bg-background h-9 rounded-md border px-2 text-sm";
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Every decision made by a person or by AI in this workspace, newest first. Nothing here can
        be edited or deleted.
      </p>
      <form
        method="get"
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label="Filter the audit log"
      >
        <label className="space-y-1 text-xs">
          <span className="block">Who</span>
          <select name="actorType" defaultValue={page.query.actorType ?? ""} className={field}>
            <option value="">Anyone</option>
            <option value="USER">People</option>
            <option value="AGENT">AI agents</option>
            <option value="SYSTEM">System</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">Person or agent</span>
          <input name="actor" defaultValue={page.query.actor ?? ""} className={field} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">Action starts with (comma-separated)</span>
          <input
            name="action"
            defaultValue={page.query.action ?? ""}
            placeholder="agent.run,approval.,outbound."
            className={`${field} w-64`}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">Target type</span>
          <input
            name="targetType"
            defaultValue={page.query.targetType ?? ""}
            className={`${field} w-36`}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">Target or run id</span>
          <input
            name="targetId"
            defaultValue={page.query.targetId ?? ""}
            className={`${field} w-48`}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">From</span>
          <input type="date" name="from" defaultValue={page.query.from ?? ""} className={field} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="block">To</span>
          <input type="date" name="to" defaultValue={page.query.to ?? ""} className={field} />
        </label>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{page.total} entries</span>
        {canExport ? (
          <>
            <a
              href={`/api/audit/export?${qs({ format: "csv" })}`}
              className="underline"
              data-testid="export-csv"
            >
              Export CSV
            </a>
            <a href={`/api/audit/export?${qs({ format: "json" })}`} className="underline">
              Export JSON
            </a>
            <span className="text-muted-foreground text-xs">Exports are recorded here too.</span>
          </>
        ) : (
          <span className="text-muted-foreground text-xs">Only Admins can export.</span>
        )}
      </div>
      {page.rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border p-6 text-sm">No entries match.</p>
      ) : (
        <ol className="divide-y rounded-md border text-sm" data-testid="audit-rows">
          {page.rows.map((r) => (
            <li
              key={r.id}
              className="space-y-0.5 p-3"
              data-testid="audit-row"
              data-action={r.action}
            >
              <p>
                <span className="font-medium">{r.summary}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                {formatDateTime(r.createdAt, ctx.workspace.timezone)} · {r.actorLabel} · {r.action}
                {r.targetType ? ` · ${r.targetType}` : ""}
                {r.agentRunId ? (
                  <>
                    {" · "}
                    <Link href={`/agent-runs/${r.agentRunId}` as Route} className="underline">
                      agent run
                    </Link>
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ol>
      )}
      {page.next !== null || page.query.cursor > 0 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {page.query.cursor > 0 ? (
            <Link
              href={
                `/settings/audit?${qs({ cursor: String(Math.max(0, page.query.cursor - 50)) })}` as Route
              }
              className="hover:underline"
            >
              Newer
            </Link>
          ) : null}
          {page.next !== null ? (
            <Link
              href={`/settings/audit?${qs({ cursor: String(page.next) })}` as Route}
              className="hover:underline"
            >
              Older
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
