import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NativeSelect } from "@/components/app/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { TIER_LABELS, TIERS } from "@/modules/accounts/schemas";
import { listOwners } from "@/modules/accounts/service";
import {
  figureText,
  getLatestReport,
  isReportKey,
  PERIOD_DAYS,
  REPORT_TITLES,
  ReportFilterError,
  reportFilters,
  type Figure,
} from "@/modules/reports/service";
import { listSegments } from "@/modules/segments/service";
import { generateReportAction } from "./actions";

type Params = Promise<{ reportKey: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { reportKey } = await params;
  return { title: isReportKey(reportKey) ? REPORT_TITLES[reportKey].title : "Report" };
}

function FigureRow({ f }: { f: Figure }) {
  const text = figureText(f);
  const links = f.sources.links ?? [];
  const shown = f.value !== null && !f.restricted;
  return (
    <div className="border-border border-b py-2 text-sm" data-testid="figure">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span>{f.label}</span>
        <span className="font-medium tabular-nums">
          {f.href && shown ? (
            <Link href={f.href as Route} className="underline">
              {text}
            </Link>
          ) : (
            text
          )}
        </span>
      </div>
      {f.value === null && f.reason ? (
        <p className="text-muted-foreground text-xs">{f.reason}</p>
      ) : null}
      {shown && f.sources.ids.length > 0 ? (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">
            {f.sources.ids.length} {f.sources.type} record{f.sources.ids.length === 1 ? "" : "s"}
          </summary>
          {links.length ? (
            <ul className="mt-1 space-y-0.5">
              {links.map((l) => (
                <li key={l.id}>
                  <Link href={l.href as Route} className="underline">
                    {l.label ?? `${f.sources.type} ${l.id.slice(0, 8)}`}
                  </Link>
                </li>
              ))}
              {f.sources.ids.length > links.length ? (
                <li className="text-muted-foreground">
                  and {f.sources.ids.length - links.length} more
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-1">
              Record ids: {f.sources.ids.slice(0, 20).join(", ")}
              {f.sources.ids.length > 20 ? " …" : ""}
            </p>
          )}
        </details>
      ) : null}
    </div>
  );
}

/**
 * One report: filters, the latest stored snapshot (its date, scope and every figure with the
 * records behind it) and a Generate button that stores a new one. Money shows "Restricted"
 * without revenue access. Nothing is computed on this page: it shows the stored snapshot.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { reportKey } = await params;
  const ctx = await resolveWorkspaceContext(await requireSession());
  const grant = ctx ? can(ctx, "reports:view") : null;
  if (!ctx || !grant || !isReportKey(reportKey)) notFound();
  const sp = await searchParams;
  const parsed = reportFilters.safeParse({
    periodDays: one(sp.periodDays),
    start: one(sp.start),
    end: one(sp.end),
    owner: one(sp.owner),
    tier: one(sp.tier),
    segment: one(sp.segment),
  });
  const filters = parsed.success ? parsed.data : {};
  const filterError = parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
  const error = one(sp.error) ?? filterError;

  const [owners, segments] = await Promise.all([listOwners(ctx), listSegments(ctx)]);
  let report = null;
  let loadError: string | null = null;
  try {
    report = await getLatestReport(ctx, reportKey, filters);
  } catch (e) {
    if (e instanceof ReportFilterError) loadError = e.message;
    else throw e;
  }
  const meta = REPORT_TITLES[reportKey];
  const custom = filters.start !== undefined && filters.end !== undefined;
  const days = filters.periodDays ?? 90;
  const hidden = (name: string, value: string | number | undefined) =>
    value === undefined ? null : <input type="hidden" name={name} value={value} />;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm">
          <Link href={"/reports" as Route} className="underline">
            Reports
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{meta.title}</h1>
        <p className="text-muted-foreground text-sm">{meta.description}</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Report filters">
        <div className="space-y-1">
          <label htmlFor="periodDays" className="text-muted-foreground block text-xs">
            Period
          </label>
          <NativeSelect id="periodDays" name="periodDays" defaultValue={custom ? "" : String(days)}>
            <option value="">Custom dates (fill From and To)</option>
            {PERIOD_DAYS.map((n) => (
              <option key={n} value={n}>
                Last {n} days
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="start" className="text-muted-foreground block text-xs">
            From (custom)
          </label>
          <Input
            id="start"
            name="start"
            type="date"
            defaultValue={filters.start ?? ""}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="end" className="text-muted-foreground block text-xs">
            To (custom)
          </label>
          <Input
            id="end"
            name="end"
            type="date"
            defaultValue={filters.end ?? ""}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="owner" className="text-muted-foreground block text-xs">
            Owner
          </label>
          <NativeSelect id="owner" name="owner" defaultValue={filters.owner ?? ""}>
            <option value="">All owners</option>
            <option value="none">No owner</option>
            {owners.map((o) => (
              <option key={o.membershipId} value={o.membershipId}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="tier" className="text-muted-foreground block text-xs">
            Tier
          </label>
          <NativeSelect id="tier" name="tier" defaultValue={filters.tier ?? ""}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <label htmlFor="segment" className="text-muted-foreground block text-xs">
            Segment
          </label>
          <NativeSelect id="segment" name="segment" defaultValue={filters.segment ?? ""}>
            <option value="">No segment</option>
            {segments
              .filter((s) => s.valid)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Show latest
        </Button>
      </form>
      {grant.scope !== "ALL" ? (
        <p className="text-muted-foreground text-xs">
          Reports cover your own accounts only. Choosing another owner narrows that further; it
          never adds accounts.
        </p>
      ) : null}

      {error || loadError ? (
        <p role="alert" className="text-destructive text-sm">
          {loadError ?? error}
        </p>
      ) : null}

      <section aria-labelledby="snap-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="snap-h" className="text-lg font-semibold">
            {report ? "Latest snapshot" : "No snapshot yet"}
          </h2>
          <form action={generateReportAction}>
            <input type="hidden" name="reportKey" value={reportKey} />
            {custom ? (
              <>
                {hidden("start", filters.start)}
                {hidden("end", filters.end)}
              </>
            ) : (
              hidden("periodDays", days)
            )}
            {hidden("owner", filters.owner)}
            {hidden("tier", filters.tier)}
            {hidden("segment", filters.segment)}
            <Button type="submit">Generate with these filters</Button>
          </form>
        </div>

        {report ? (
          <>
            <p className="text-muted-foreground text-sm" data-testid="snapshot-meta">
              Generated {formatDateTime(report.generatedAt, ctx.workspace.timezone)}
              {report.trigger === "SCHEDULED" ? " (scheduled)" : ""} · {report.data.periodStart} to{" "}
              {report.data.periodEnd} · {report.data.accountsInScope} account
              {report.data.accountsInScope === 1 ? "" : "s"}
              {filters.tier ? ` · ${TIER_LABELS[filters.tier]}` : ""}
            </p>
            {report.data.accountsInScope === 0 ? (
              <p className="text-sm">
                No accounts matched these filters in your book, so there is nothing to report.
              </p>
            ) : null}
            {report.data.notes.map((n) => (
              <p key={n} className="text-muted-foreground text-xs">
                {n}
              </p>
            ))}
            {report.data.sections.map((s) => (
              <section key={s.title} className="space-y-1" aria-label={s.title}>
                <h3 className="font-medium">{s.title}</h3>
                {s.note ? <p className="text-muted-foreground text-xs">{s.note}</p> : null}
                <div>
                  {s.figures.map((f) => (
                    <FigureRow key={f.label} f={f} />
                  ))}
                </div>
              </section>
            ))}
          </>
        ) : (
          <p className="text-sm">
            Nothing has been generated for these filters yet. Press Generate to compute it from your
            records now; the result is stored with today&apos;s date.
          </p>
        )}
      </section>
    </div>
  );
}
