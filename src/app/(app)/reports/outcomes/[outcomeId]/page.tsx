import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatMoney } from "@/lib/money";
import {
  LEDGER_DEFINITIONS,
  LEDGER_LABEL,
  loadSaveRecord,
  type LinkedItem,
} from "@/modules/outcomes/service";

export const metadata: Metadata = { title: "Save record" };

const fmt = (d: Date) => d.toISOString().slice(0, 10);

function Item({ i }: { i: LinkedItem }) {
  return (
    <li>
      {i.href ? (
        <Link href={i.href as Route} className="underline">
          {i.label}
        </Link>
      ) : (
        <span>{i.label}</span>
      )}
      {i.note ? <span className="text-muted-foreground"> ({i.note})</span> : null}
    </li>
  );
}

/**
 * One save record: the flag, what was done, what the 7/30/90-day checkpoints found (each with the
 * records it cites), and the value with its plain-words definition. Attributed, not causal (Q-15).
 */
export default async function SaveRecordPage({
  params,
}: {
  params: Promise<{ outcomeId: string }>;
}) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "reports:view")) notFound();
  const { outcomeId } = await params;
  const r = await loadSaveRecord(ctx, outcomeId);
  if (!r) notFound();
  return (
    <div className="space-y-6">
      <div>
        <Link
          href={"/reports/outcomes" as Route}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Did it work?
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Save record: {r.accountName}</h1>
        <p className="text-muted-foreground text-sm">
          {r.flagType === "RISK" ? "Risk" : "Opportunity"} flagged {fmt(r.flaggedAt)} ·{" "}
          {r.actionTaken === "ACTED"
            ? "the team acted"
            : r.actionTaken === "IGNORED"
              ? "no action taken"
              : "no action yet"}{" "}
          · {LEDGER_LABEL}
        </p>
      </div>

      <section aria-labelledby="flag-h" className="space-y-1">
        <h2 id="flag-h" className="text-lg font-semibold">
          The flag
        </h2>
        {r.signal ? (
          <p className="text-sm">
            <Link href={r.signal.href as Route} className="underline">
              {r.signal.title}
            </Link>{" "}
            (rule {r.signal.ruleKey})
          </p>
        ) : (
          <p className="text-sm">
            No signal is linked to this record (it was flagged by an agent run).
          </p>
        )}
        <p className="text-sm">
          <Link href={`/accounts/${r.accountId}` as Route} className="underline">
            {r.accountName}
          </Link>
        </p>
      </section>

      <section aria-labelledby="actions-h" className="space-y-1">
        <h2 id="actions-h" className="text-lg font-semibold">
          What was done
        </h2>
        {r.actions.length === 0 ? (
          <p className="text-sm">No action is on record for this flag.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {r.actions.map((a) => (
              <Item key={`${a.type}-${a.id}`} i={a} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="cp-h" className="space-y-3">
        <h2 id="cp-h" className="text-lg font-semibold">
          What the checkpoints found
        </h2>
        {r.checkpoints.length === 0 ? (
          <p className="text-sm">No checkpoint has been recorded yet.</p>
        ) : (
          r.checkpoints.map((c) => (
            <div key={c.day} className="space-y-1" data-testid={`checkpoint-${c.day}`}>
              <p className="text-sm font-medium">
                Day {c.day}: {c.status}
                {c.dueOn ? ` (due ${c.dueOn})` : ""}
              </p>
              {c.detail ? <p className="text-muted-foreground text-sm">{c.detail}</p> : null}
              {c.evidence.length === 0 ? (
                <p className="text-sm">No records are cited for this result.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {c.evidence.map((e) => (
                    <Item key={`${e.type}-${e.id}`} i={e} />
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="value-h" className="space-y-1">
        <h2 id="value-h" className="text-lg font-semibold">
          Value
        </h2>
        <p className="text-sm" data-testid="saved-value">
          {!r.moneyVisible
            ? "Restricted: money is shown to members with revenue access."
            : r.saved
              ? r.valueSavedMinor !== null && r.arrCurrency
                ? `Saved: ${formatMoney({ minor: r.valueSavedMinor, currency: r.arrCurrency })}`
                : "Saved, but no ARR was on file at the flag, so no money is counted."
              : "Not counted as a save."}
        </p>
        <p className="text-muted-foreground text-sm">{LEDGER_DEFINITIONS.saved}</p>
      </section>
    </div>
  );
}
