import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getRunDetail } from "@/modules/agents/service";

export const metadata: Metadata = { title: "Agent run" };

const Links = ({
  items,
  label,
}: {
  items: Array<{ label: string; href: string | null; missing: boolean }>;
  label: string;
}) =>
  items.length ? (
    <ul className="list-disc space-y-1 pl-5 text-sm" aria-label={label}>
      {items.map((i, n) => (
        <li key={n}>
          {i.href ? (
            <Link href={i.href as Route} className="text-primary underline underline-offset-2">
              {i.label}
            </Link>
          ) : (
            <span className={i.missing ? "text-muted-foreground" : undefined}>{i.label}</span>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-muted-foreground text-sm">None.</p>
  );

/**
 * One agent run (ARCHITECTURE §6.4): what it read, what it decided, what it did. A run that did
 * not succeed shows its status and reason and nothing of its output (Rules 1, 4).
 */
export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const d = await getRunDetail(ctx, id).catch((e: unknown) => {
    if (e instanceof Error && e.name === "AgentRunNotFoundError") notFound();
    throw e;
  });
  const r = d.run;
  const tz = ctx.workspace.timezone;
  const ok = r.status === "SUCCEEDED";
  const output = ok ? (r.output as Record<string, unknown>) : null;
  return (
    <div className="space-y-section max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {r.agentKey} run{r.account ? `: ${r.account.name}` : ""}
        </h1>
        <p
          className="text-muted-foreground text-sm"
          data-testid="run-status"
          data-status={r.status}
        >
          {r.status.toLowerCase().replaceAll("_", " ")}
          {r.errorCode && !ok ? ` (${r.errorCode})` : ""} · {formatDateTime(r.createdAt, tz)} ·
          agent v{r.agentVersion} · prompt {r.promptName}@{r.promptVersion ?? "?"} · model{" "}
          {r.model ?? "none (no call completed)"} · tier {r.modelTier} ·{" "}
          {r.inputTokens + r.outputTokens} tokens · attempt {r.attempt}
          {r.cacheReadTokens > 0 || r.cacheCreationTokens > 0
            ? ` · cache: ${r.cacheReadTokens} read, ${r.cacheCreationTokens} written`
            : ""}
          {r.batchId ? " · batch (half price)" : ""}
        </p>
        {!ok ? (
          <p
            className="border-warning/30 bg-warning-soft text-warning-soft-foreground mt-2 rounded-md border p-3 text-sm"
            data-testid="run-not-shown"
          >
            This run did not succeed, so nothing it produced is shown anywhere in the product.
            {r.errorDetail ? ` Reason: ${r.errorDetail}` : ""}
          </p>
        ) : null}
      </div>
      <section aria-labelledby="read" className="surface space-y-2 p-5">
        <h2 id="read" className="text-base font-semibold">
          What it read ({d.read.length})
        </h2>
        <Links items={d.read} label="Records the run was given" />
      </section>
      {ok && output ? (
        <section aria-labelledby="decided" className="surface space-y-2 p-5">
          <h2 id="decided" className="text-base font-semibold">
            What it decided
          </h2>
          <p className="text-sm">{r.reasoningSummary}</p>
          <p className="text-muted-foreground text-xs">
            Model confidence {Math.round((r.confidence ?? 0) * 100)}% (the model&rsquo;s own
            estimate, not a score)
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">Structured output</summary>
            <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-2 text-xs whitespace-pre-wrap">
              {JSON.stringify(output, null, 2)}
            </pre>
          </details>
        </section>
      ) : null}
      <section aria-labelledby="did" className="surface space-y-2 p-5">
        <h2 id="did" className="text-base font-semibold">
          What it did: {r.actionTaken.toLowerCase().replaceAll("_", " ")}
        </h2>
        <Links items={d.did} label="Records the run created or changed" />
        {d.approvals.map((a) => (
          <p key={a.id} className="text-sm" data-testid="run-approval">
            <Link
              href={`/approvals/${a.id}` as Route}
              className="text-primary underline underline-offset-2"
            >
              Approval
            </Link>
            : {a.status.toLowerCase().replaceAll("_", " ")}
            {a.decidedBy ? ` by ${a.decidedBy}` : ""}
            {a.decidedAt ? ` on ${formatDateTime(a.decidedAt, tz)}` : ""}
            {a.note ? `: “${a.note}”` : ""}
          </p>
        ))}
      </section>
      <section aria-labelledby="trail" className="surface space-y-2 p-5">
        <h2 id="trail" className="text-base font-semibold">
          Audit trail
        </h2>
        <ul className="space-y-1 text-sm">
          {d.audit.map((a, i) => (
            <li key={i}>
              {formatDateTime(a.createdAt, tz)} · {a.summary}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
