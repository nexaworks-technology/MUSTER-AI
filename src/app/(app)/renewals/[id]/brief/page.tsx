import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatCalendarDate } from "@/lib/format";
import { askRenewalManagerAction, buildBriefAction } from "@/modules/documents/actions/brief";
import { DocumentError, getRenewalBrief } from "@/modules/documents/service";

export const metadata: Metadata = { title: "Renewal brief" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function sourceHref(accountId: string, s: { sourceType: string }): Route | null {
  const base = `/accounts/${accountId}`;
  switch (s.sourceType) {
    case "Contract":
      return `${base}/billing` as Route;
    case "HealthScoreSnapshot":
      return `${base}/health` as Route;
    case "Signal":
      return `${base}/signals` as Route;
    case "Renewal":
      return `${base}/renewal` as Route;
    case "ExpansionOpportunity":
      return `${base}/expansion` as Route;
    default:
      return null;
  }
}

/**
 * Renewal brief (spec §6H2): locked metrics computed by code from records, each with the records
 * behind it, and the Renewal Manager's narrative, whose figures are placeholders filled from those
 * same locked metrics. Money reads "Restricted" without revenue access.
 */
export default async function RenewalBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();
  const { id } = await params;
  let page;
  try {
    page = await getRenewalBrief(ctx, id);
  } catch (e) {
    if (e instanceof DocumentError) notFound();
    throw e;
  }
  const q = await searchParams;
  const doc = page.document;
  const canEdit = doc?.canEdit ?? can(ctx, "accounts:edit") !== null;
  return (
    <div className="space-y-5">
      <p className="text-sm">
        <Link href="/renewals" className="underline">
          Renewals
        </Link>{" "}
        /{" "}
        <Link href={`/accounts/${page.renewal.accountId}/renewal` as Route} className="underline">
          {page.renewal.accountName}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">Renewal brief: {page.renewal.accountName}</h1>
      <p className="text-muted-foreground text-sm">
        Renewal on {formatCalendarDate(page.renewal.renewalDate)}.
      </p>
      {one(q.ok) ? (
        <p role="status" className="text-sm">
          {one(q.ok)}
        </p>
      ) : null}
      {one(q.error) ? (
        <p role="alert" className="text-sm">
          {one(q.error)}
        </p>
      ) : null}

      {!doc ? (
        <section className="space-y-3">
          <p className="text-sm">
            No brief has been built for this renewal yet. Building one reads the records and locks
            the figures; no model is involved.
          </p>
        </section>
      ) : (
        <>
          <section aria-labelledby="metrics-h" className="space-y-2" data-testid="brief-metrics">
            <h2 id="metrics-h" className="text-lg font-semibold">
              Locked figures
            </h2>
            <p className="text-muted-foreground text-xs">
              Worked out by code from the records below and locked
              {doc.lockedAt ? ` on ${formatCalendarDate(doc.lockedAt)}` : ""}. The narrative can
              only refer to them; it cannot change them.
            </p>
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Locked metrics and their sources</caption>
              <thead>
                <tr className="border-border border-b">
                  <th scope="col" className="py-1 pr-3">
                    Figure
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Value
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    From
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.metrics.map((m) => (
                  <tr key={m.key} className="border-border border-b align-top" data-metric={m.key}>
                    <th scope="row" className="py-1 pr-3 font-normal">
                      {m.label}
                    </th>
                    <td className="py-1 pr-3">{m.text}</td>
                    <td className="py-1 pr-3 text-xs">
                      {m.sources.length === 0 ? (
                        <span className="text-muted-foreground">No records</span>
                      ) : (
                        m.sources.map((s, i) => {
                          const href = sourceHref(doc.accountId, s);
                          const label = `${s.sourceType}${s.sourceId ? ` ${s.sourceId.slice(0, 8)}` : ""}`;
                          return href ? (
                            <Link key={i} href={href} className="mr-2 underline">
                              {label}
                            </Link>
                          ) : (
                            <span key={i} className="text-muted-foreground mr-2">
                              {label}
                            </span>
                          );
                        })
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="narr-h" className="space-y-2" data-testid="brief-narrative">
            <h2 id="narr-h" className="text-lg font-semibold">
              Plan and talk track
            </h2>
            {doc.rendered.length === 0 ? (
              <p className="text-sm">
                No plan has been written yet. Ask the Renewal Manager to draft one from these
                records.
              </p>
            ) : (
              <div className="space-y-1 text-sm">
                {doc.rendered.map((b) =>
                  b.type === "heading" ? (
                    <h3 key={b.id} className="pt-2 font-medium">
                      {b.text}
                    </h3>
                  ) : b.type === "bullet" ? (
                    <p key={b.id} className="pl-4">
                      • {b.text}
                    </p>
                  ) : (
                    <p key={b.id}>{b.text}</p>
                  ),
                )}
              </div>
            )}
            {doc.origin === "AI" && doc.agentRunId ? (
              <p className="text-muted-foreground text-xs">
                Written by the Renewal Manager from the records above;{" "}
                <Link href={`/agent-runs/${doc.agentRunId}` as Route} className="underline">
                  see the run
                </Link>
                . Any outreach it drafted is in Approvals; nothing was sent.
              </p>
            ) : null}
          </section>
        </>
      )}

      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          <form action={buildBriefAction.bind(null, id)}>
            <button type="submit" className="border-input rounded-md border px-3 py-1 text-sm">
              {doc ? "Rebuild the figures from the records" : "Build the brief"}
            </button>
          </form>
          <form action={askRenewalManagerAction.bind(null, id)}>
            <button type="submit" className="border-input rounded-md border px-3 py-1 text-sm">
              Ask the Renewal Manager to draft the plan
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
