import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApprovalActions } from "@/components/app/approval-actions";
import { Badge } from "@/components/ui/badge";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { scopedDb } from "@/lib/db/scoped";
import { LEVEL_WORDS, sensitiveLabel } from "@/modules/approvals/schemas";
import {
  canDecideApproval,
  getApproval,
  parseProof,
  resolveProof,
} from "@/modules/approvals/service";

export const metadata: Metadata = { title: "Approval" };

const when = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tz,
  }).format(d);

/** One approval: the reason and its proof, the draft and every version, and the decision. */
export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const a = await getApproval(ctx, id).catch((e: unknown) => {
    if (e instanceof Error && (e.name === "ApprovalNotFoundError" || e.name === "ForbiddenError"))
      notFound();
    throw e;
  });
  const proof = a.accountId
    ? await resolveProof(scopedDb(ctx), a.accountId, parseProof(a.proof))
    : [];
  const message = a.outboundMessages[0] ?? null;
  const latest = a.revisions.at(-1) ?? null;
  const canDecide = canDecideApproval(ctx, a);
  const tz = ctx.workspace.timezone;
  const guards = Array.isArray(message?.guardResults)
    ? (message.guardResults as Array<{ guard: string; passed: boolean; detail: string }>)
    : [];

  return (
    <div className="space-y-section max-w-3xl">
      <div className="space-y-1">
        <Link
          href={"/approvals" as Route}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Approvals
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{a.reason}</h1>
        <p className="text-muted-foreground text-sm">
          {a.account ? (
            <>
              <Link href={`/accounts/${a.account.id}` as Route} className="hover:underline">
                {a.account.name}
              </Link>{" "}
              ·{" "}
            </>
          ) : null}
          {a.kind === "SEND_EMAIL" ? "Customer email" : a.kind.toLowerCase().replaceAll("_", " ")} ·{" "}
          <span data-testid="approval-level">
            {a.isSensitive ? "Draft for approval · Always human" : LEVEL_WORDS[a.requiredLevel]}
          </span>{" "}
          · <span data-testid="approval-status">{a.status.toLowerCase().replaceAll("_", " ")}</span>
        </p>
      </div>

      {a.isSensitive ? (
        <p
          className="border-danger/30 bg-danger-soft text-danger-soft-foreground rounded-lg border px-4 py-3 text-sm font-medium"
          data-testid="sensitive-banner"
        >
          {sensitiveLabel(a.sensitiveReasons)}. A person always decides this; it can never be sent
          automatically.
        </p>
      ) : null}

      <section aria-labelledby="proof-heading" className="surface space-y-3 p-5 rounded-xl border border-border/80 shadow-xs">
        <h2 id="proof-heading" className="text-base font-semibold">
          Why, with proof
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="approval-proof">
          {proof.map((p) => (
            <li key={`${p.sourceType}:${p.sourceId}`}>
              {p.href ? (
                <Link href={p.href as Route} className="text-primary underline underline-offset-2">
                  {p.label}
                </Link>
              ) : (
                <span className={p.missing ? "text-muted-foreground" : undefined}>{p.label}</span>
              )}
            </li>
          ))}
        </ul>
        {a.proposedByRun ? (
          <p className="text-muted-foreground text-sm">
            Drafted by the{" "}
            <Link
              href={`/agent-runs/${a.proposedByRun.id}` as Route}
              className="text-primary underline underline-offset-2"
            >
              {a.proposedByRun.agentKey} agent (what it read)
            </Link>
            .
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">Written by a person.</p>
        )}
      </section>

      {message && latest ? (
        <section aria-labelledby="draft-heading" className="surface space-y-3 p-5 rounded-xl border border-border/80 shadow-xs">
          <h2 id="draft-heading" className="text-base font-semibold">
            The email (version {latest.version})
          </h2>
          <div className="surface space-y-1 p-4 text-sm" data-testid="draft">
            <p>
              <span className="text-muted-foreground">To:</span> {message.toEmail}
            </p>
            <p>
              <span className="text-muted-foreground">Subject:</span> {latest.subject}
            </p>
            <p className="border-border mt-3 border-t pt-3 whitespace-pre-wrap">
              {latest.bodyText}
            </p>
          </div>
          <p className="text-muted-foreground text-sm" data-testid="message-status">
            Email status: {message.status.toLowerCase().replaceAll("_", " ")}
            {message.sentAt
              ? `, sent ${when(message.sentAt, tz)} (${message.transport} transport)`
              : ""}
            {message.heldReason && message.status !== "SENT" ? `. ${message.heldReason}` : ""}
          </p>
          {a.revisions.length > 1 ? (
            <details className="text-sm">
              <summary className="cursor-pointer">
                Earlier versions ({a.revisions.length - 1})
              </summary>
              <ol className="mt-2 space-y-2">
                {a.revisions.slice(0, -1).map((v) => (
                  <li key={v.id} className="bg-card border-border rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">
                      Version {v.version} ·{" "}
                      {v.origin === "AI" ? "AI draft" : (v.editedBy?.user.name ?? "a person")}
                    </p>
                    <p className="whitespace-pre-wrap">{v.bodyText}</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {guards.length ? (
            <details className="text-sm" data-testid="guard-results">
              <summary className="cursor-pointer">
                Send checks ({guards.filter((g) => !g.passed).length} not passed)
              </summary>
              <ul className="mt-2 space-y-1">
                {guards.map((g) => (
                  <li key={g.guard}>
                    <Badge variant={g.passed ? "success" : "danger"}>
                      {g.passed ? "Passed" : "Not passed"}
                    </Badge>{" "}
                    {g.detail}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {canDecide ? (
        <section aria-labelledby="decide-heading" className="surface space-y-4 p-5 rounded-xl border border-border/80 shadow-xs">
          <h2 id="decide-heading" className="text-base font-semibold">
            Decide
          </h2>
          <ApprovalActions
            approvalId={a.id}
            draft={latest ? { subject: latest.subject, body: latest.bodyText } : null}
          />
        </section>
      ) : a.decidedAt ? (
        <p
          className="bg-card border-border rounded-lg border px-4 py-3 text-sm"
          data-testid="decision"
        >
          {a.status === "REJECTED" ? "Rejected" : "Approved"} by{" "}
          {a.decidedBy?.user.name ?? "a member"} on {when(a.decidedAt, tz)}
          {a.decisionNote ? `: “${a.decisionNote}”` : "."}
        </p>
      ) : null}
    </div>
  );
}
