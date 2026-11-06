import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <div className="space-y-section">
      <p className="text-sm">
        <Link href="/renewals" className="text-primary underline underline-offset-2">
          Renewals
        </Link>{" "}
        /{" "}
        <Link
          href={`/accounts/${page.renewal.accountId}/renewal` as Route}
          className="text-primary underline underline-offset-2"
        >
          {page.renewal.accountName}
        </Link>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Renewal brief: {page.renewal.accountName}
      </h1>
      <p className="text-muted-foreground text-sm">
        Renewal on {formatCalendarDate(page.renewal.renewalDate)}.
      </p>
      {one(q.ok) ? (
        <p role="status" className="bg-muted text-foreground rounded-md px-3 py-2 text-sm">
          {one(q.ok)}
        </p>
      ) : null}
      {one(q.error) ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
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
          <section
            aria-labelledby="metrics-h"
            className="surface space-y-3 p-5"
            data-testid="brief-metrics"
          >
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
                <tr>
                  <th scope="col">Figure</th>
                  <th scope="col">Value</th>
                  <th scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {doc.metrics.map((m) => (
                  <tr key={m.key} className="border-border align-top" data-metric={m.key}>
                    <th scope="row" className="font-normal">
                      {m.label}
                    </th>
                    <td>{m.text}</td>
                    <td className="text-xs">
                      {m.sources.length === 0 ? (
                        <span className="text-muted-foreground">No records</span>
                      ) : (
                        m.sources.map((s, i) => {
                          const href = sourceHref(doc.accountId, s);
                          const label = `${s.sourceType}${s.sourceId ? ` ${s.sourceId.slice(0, 8)}` : ""}`;
                          return href ? (
                            <Link
                              key={i}
                              href={href}
                              className="text-primary mr-2 underline underline-offset-2"
                            >
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

          <section
            aria-labelledby="narr-h"
            className="surface space-y-3 p-5"
            data-testid="brief-narrative"
          >
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
                <Link
                  href={`/agent-runs/${doc.agentRunId}` as Route}
                  className="text-primary underline underline-offset-2"
                >
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
              className="surface space-y-3 p-5"
              data-testid="adopted-plan-section"
            >
              <div className="flex items-center justify-between">
                <h2 id="adopted-plan-h" className="text-lg font-semibold">
                  Adopted renewal plan
                </h2>
                <Badge variant="success">
                  {page.renewal.planSteps.length} step
                  {page.renewal.planSteps.length === 1 ? "" : "s"} adopted
                </Badge>
              </div>
              <ol className="list-inside list-decimal space-y-2 text-sm">
                {page.renewal.planSteps.map((s, idx) => (
                  <li key={idx} className="font-medium">
                    <span>{s.title}</span>
                    {s.detail && (
                      <p className="text-muted-foreground pl-5 text-xs font-normal">{s.detail}</p>
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
              className="surface space-y-4 p-5"
              data-testid="adopt-plan-section"
            >
              <div>
                <h2 id="adopt-plan-h" className="text-base font-semibold">
                  {page.renewal.planSteps.length > 0
                    ? "Edit & re-adopt plan steps"
                    : "Adopt proposed plan steps"}
                </h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  Steps are editable before human adoption. Adopting writes into Renewal.planSteps.
                  Figures must obey locked placeholder rules.
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
                          <label className="text-muted-foreground font-mono">Step 1 Title</label>
                          <Input
                            type="text"
                            name="step_title_0"
                            placeholder="e.g. Schedule executive renewal review"
                            required
                            className="font-medium"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted-foreground font-mono">
                            Step 1 Detail (optional)
                          </label>
                          <Input
                            type="text"
                            name="step_detail_0"
                            placeholder="e.g. Review {{metric.renewal.arr}} and metrics"
                            className="text-muted-foreground"
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
                            <span className="text-muted-foreground min-w-12 font-mono">
                              Step {idx + 1}
                            </span>
                            <Input
                              type="text"
                              name={`step_title_${idx}`}
                              defaultValue={step.title}
                              placeholder="Step Title"
                              required
                              className="flex-1 font-medium"
                              aria-label={`Step ${idx + 1} Title`}
                            />
                          </div>
                          <div className="pl-14">
                            <Input
                              type="text"
                              name={`step_detail_${idx}`}
                              defaultValue={step.detail ?? ""}
                              placeholder="Detail (optional)"
                              className="text-muted-foreground"
                              aria-label={`Step ${idx + 1} Detail`}
                            />
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
                <Button type="submit">Adopt plan into renewal</Button>
              </form>
            </section>
          )}
        </>
      )}

      {canEdit ? (
        <div className="flex flex-wrap gap-3">
          <form action={buildBriefAction.bind(null, id)}>
            <Button type="submit" variant="outline" size="sm">
              {doc ? "Rebuild the figures from the records" : "Build the brief"}
            </Button>
          </form>
          <form action={askRenewalManagerAction.bind(null, id)}>
            <Button type="submit" variant="outline" size="sm">
              Ask the Renewal Manager to draft the plan
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
