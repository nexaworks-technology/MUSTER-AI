import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatCalendarDate } from "@/lib/format";
import {
  adoptPlanAction,
  askRenewalManagerAction,
  buildBriefAction,
} from "@/modules/documents/actions/brief";
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

          {/* Adopted Renewal Plan (D-139) */}
          {page.renewal.planSteps.length > 0 && (
            <section
              aria-labelledby="adopted-plan-h"
              className="space-y-3 border-t pt-4"
              data-testid="adopted-plan-section"
            >
              <div className="flex items-center justify-between">
                <h2 id="adopted-plan-h" className="text-lg font-semibold">
                  Adopted renewal plan
                </h2>
                <span className="text-xs bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 px-2 py-0.5 rounded font-medium">
                  {page.renewal.planSteps.length} step{page.renewal.planSteps.length === 1 ? "" : "s"} adopted
                </span>
              </div>
              <ol className="list-decimal list-inside space-y-2 text-sm">
                {page.renewal.planSteps.map((s, idx) => (
                  <li key={idx} className="font-medium">
                    <span>{s.title}</span>
                    {s.detail && (
                      <p className="text-xs text-muted-foreground pl-5 font-normal">{s.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Adopt Proposed Plan Form (D-139: steps editable before adoption) */}
          {canEdit && (
            <section
              aria-labelledby="adopt-plan-h"
              className="space-y-4 border rounded-lg p-4 bg-muted/20"
              data-testid="adopt-plan-section"
            >
              <div>
                <h2 id="adopt-plan-h" className="text-base font-semibold">
                  {page.renewal.planSteps.length > 0
                    ? "Edit & re-adopt plan steps"
                    : "Adopt proposed plan steps"}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Steps are editable before human adoption. Adopting writes into Renewal.planSteps. Figures must obey locked placeholder rules.
                </p>
              </div>
              <form action={adoptPlanAction.bind(null, id)} className="space-y-3">
                {(() => {
                  const proposedSteps = doc.rendered
                    .filter((b) => b.id.startsWith("plan-") && b.id !== "plan-h")
                    .map((b) => {
                      const idx = b.text.indexOf(":");
                      if (idx !== -1) {
                        return {
                          title: b.text.slice(0, idx).trim(),
                          detail: b.text.slice(idx + 1).trim(),
                        };
                      }
                      return { title: b.text.trim(), detail: "" };
                    });

                  const stepsToEdit =
                    proposedSteps.length > 0 ? proposedSteps : page.renewal.planSteps;

                  if (stepsToEdit.length === 0) {
                    return (
                      <div className="space-y-2 text-xs">
                        <div className="space-y-1">
                          <label className="font-mono text-muted-foreground">Step 1 Title</label>
                          <input
                            type="text"
                            name="step_title_0"
                            placeholder="e.g. Schedule executive renewal review"
                            required
                            className="border rounded px-2 py-1 w-full font-medium bg-background"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="font-mono text-muted-foreground">Step 1 Detail (optional)</label>
                          <input
                            type="text"
                            name="step_detail_0"
                            placeholder="e.g. Review {{metric.renewal.arr}} and metrics"
                            className="border rounded px-2 py-1 w-full text-muted-foreground bg-background"
                          />
                        </div>
                      </div>
                    );
                  }

                  return (
                    <>
                      {stepsToEdit.map((step, idx) => (
                        <div key={idx} className="space-y-1.5 border-b pb-3 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-muted-foreground min-w-[50px]">
                              Step {idx + 1}
                            </span>
                            <input
                              type="text"
                              name={`step_title_${idx}`}
                              defaultValue={step.title}
                              placeholder="Step Title"
                              required
                              className="border rounded px-2 py-1 flex-1 font-medium bg-background"
                              aria-label={`Step ${idx + 1} Title`}
                            />
                          </div>
                          <div className="pl-[58px]">
                            <input
                              type="text"
                              name={`step_detail_${idx}`}
                              defaultValue={step.detail ?? ""}
                              placeholder="Detail (optional)"
                              className="border rounded px-2 py-1 w-full text-muted-foreground bg-background"
                              aria-label={`Step ${idx + 1} Detail`}
                            />
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
                <button
                  type="submit"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium"
                >
                  Adopt plan into renewal
                </button>
              </form>
            </section>
          )}
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
