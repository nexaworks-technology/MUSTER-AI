import { randomUUID } from "node:crypto";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckInForm } from "@/components/app/check-in-form";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { checkInTarget } from "@/modules/agents/service";

export const metadata: Metadata = { title: "Draft check-in" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Draft check-in from a signal or a ticket (M4 §2). The result is a draft waiting for approval. */
export default async function DraftCheckInPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const sourceType = one(sp.sourceType);
  const sourceId = one(sp.sourceId);
  if ((sourceType !== "Signal" && sourceType !== "Ticket") || !sourceId) notFound();
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const target = await checkInTarget(ctx, sourceType, sourceId).catch((e: unknown) => {
    if (
      e instanceof Error &&
      ["CheckInError", "AccountNotFoundError", "ForbiddenError"].includes(e.name)
    )
      notFound();
    throw e;
  });
  const backHref =
    sourceType === "Signal"
      ? `/accounts/${target.account.id}/signals#signal-${sourceId}`
      : `/accounts/${target.account.id}/tickets#ticket-${sourceId}`;
  return (
    <div className="space-y-section max-w-2xl">
      <div className="space-y-1">
        <Link href={backHref as Route} className="text-muted-foreground text-sm hover:underline">
          ← {target.account.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Draft check-in</h1>
        <p className="text-muted-foreground text-sm">
          About: <span className="text-foreground">{target.label}</span>. Nothing is sent until
          someone approves it in Approvals.
        </p>
      </div>
      {target.messages.length ? (
        <section aria-labelledby="customer-words" className="space-y-2">
          <h2 id="customer-words" className="text-sm font-semibold">
            What the customer wrote
          </h2>
          {target.messages.map((m) => (
            <blockquote
              key={m.id}
              className="border-border bg-card rounded-md border border-l-4 p-3 text-sm whitespace-pre-wrap"
            >
              {m.bodyText}
            </blockquote>
          ))}
        </section>
      ) : null}
      <CheckInForm
        sourceType={sourceType}
        sourceId={sourceId}
        nonce={randomUUID()}
        aiConfigured={target.aiConfigured}
        contacts={target.contacts.map((c) => ({
          id: c.id,
          label: `${c.name}${c.title ? `, ${c.title}` : ""} <${c.email}>`,
        }))}
      />
    </div>
  );
}
