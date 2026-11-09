import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getQbrDocument, type ComputedQbrMetrics } from "@/modules/qbr/service";

export const metadata: Metadata = { title: "QBR" };

type Row = { label: string; value: string; source: string; href: Route };

/** Each locked figure with its label, value (or the honest "no data" reason) and source tab. */
function rows(m: Partial<ComputedQbrMetrics>, accountId: string, canViewRevenue: boolean): Row[] {
  const tab = (t: string) => `/accounts/${accountId}/${t}` as Route;
  const or = (v: string | number | null | undefined, reason: string | null | undefined) =>
    v === null || v === undefined ? (reason ?? "No data") : String(v);
  return [
    {
      label: "Health score",
      value:
        m.health?.score != null
          ? `${m.health.score} (${m.health.band ?? "no band"})`
          : or(null, m.health?.label),
      source: "Health tab",
      href: tab("health"),
    },
    {
      label: "Seats purchased",
      value: or(m.contract?.seatsPurchased, m.contract?.label),
      source: "Renewal tab",
      href: tab("renewal"),
    },
    {
      label: "Renewal date",
      value: or(m.contract?.renewalDate, m.contract?.label),
      source: "Renewal tab",
      href: tab("renewal"),
    },
    {
      label: "Latest seats used",
      value: or(m.usage?.latestSeatsUsed, m.usage?.label),
      source: "Usage tab",
      href: tab("usage"),
    },
    {
      label: "Seat utilization",
      value:
        m.usage?.utilizationPercent != null
          ? `${m.usage.utilizationPercent}%`
          : or(null, m.usage?.label),
      source: "Usage tab",
      href: tab("usage"),
    },
    {
      label: "Support tickets",
      value: m.support ? (m.support.label ?? String(m.support.ticketCount)) : "No data",
      source: "Tickets tab",
      href: tab("tickets"),
    },
    {
      label: "Promises (kept / late / open / broken)",
      value: m.promises
        ? (m.promises.label ??
          `${m.promises.kept} / ${m.promises.late} / ${m.promises.open} / ${m.promises.broken}`)
        : "No data",
      source: "Promises tab",
      href: tab("promises"),
    },
    {
      label: "ARR",
      // Stored with the generating member's visibility; re-redacted for whoever is viewing.
      value: canViewRevenue ? or(m.revenue?.arrFormatted, m.revenue?.label) : "Restricted",
      source: "Billing tab",
      href: tab("billing"),
    },
  ];
}

/** The created QBR (M12 Session C, C0a): locked metrics with their sources, and the narrative. */
export default async function QbrPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) notFound();
  const { id } = await params;
  const qbr = await getQbrDocument(ctx, id);
  if (!qbr || !qbr.accountId) notFound();
  const metrics = (qbr.body.metrics ?? {}) as Partial<ComputedQbrMetrics>;

  return (
    <div className="space-y-section max-w-4xl" data-testid="qbr-document">
      <div className="space-y-1">
        <Link href="/meetings/qbr/new" className="text-muted-foreground text-sm underline">
          New QBR
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{qbr.title}</h1>
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <Link href={`/accounts/${qbr.accountId}` as Route} className="text-primary underline">
            Account
          </Link>
          <span>· Period {qbr.body.period}</span>
          <span>· Created {formatDateTime(qbr.createdAt, ctx.workspace.timezone)}</span>
          <StatusPill variant={qbr.locked ? "success" : "neutral"} size="sm" data-testid="qbr-status">
            {qbr.locked ? "Locked" : "Draft, not shared with the customer"}
          </StatusPill>
        </p>
      </div>

      <section aria-labelledby="qbr-metrics-heading" className="space-y-3">
        <h2 id="qbr-metrics-heading" className="text-base font-semibold">
          Locked metrics
        </h2>
        <DataListCard>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="qbr-metrics">
              <caption className="sr-only">Locked metrics and the records they come from</caption>
              <thead>
                <tr className="border-border bg-muted/60 text-muted-foreground border-b text-[11px] font-semibold tracking-wider uppercase sticky top-0 z-10 backdrop-blur-sm">
                  <th scope="col" className="px-4 py-3">Metric</th>
                  <th scope="col" className="px-4 py-3">Value</th>
                  <th scope="col" className="px-4 py-3">Source</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {rows(metrics, qbr.accountId, ctx.canViewRevenue).map((r) => (
                  <tr key={r.label} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">{r.label}</td>
                    <td className="px-4 py-3 tabular-nums font-medium text-foreground">{r.value}</td>
                    <td className="px-4 py-3">
                      <Link href={r.href} className="text-primary underline hover:text-primary/80">
                        {r.source}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataListCard>
      </section>

      <section aria-labelledby="qbr-narrative-heading" className="space-y-3">
        <h2 id="qbr-narrative-heading" className="text-base font-semibold">
          Narrative
        </h2>
        <div className="space-y-3" data-testid="qbr-narrative">
          {qbr.body.blocks.map((b) => (
            <DataListCard key={b.id} className="space-y-1.5 p-5">
              <h3 className="text-sm font-semibold text-foreground">{b.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">{b.text}</p>
            </DataListCard>
          ))}
        </div>
        {qbr.agentRunId ? (
          <p className="text-muted-foreground text-xs">
            Written by the Meeting &amp; QBR agent from this account&apos;s records.{" "}
            <Link
              href={`/agent-runs/${qbr.agentRunId}` as Route}
              className="text-primary underline"
            >
              See what it read and decided
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
