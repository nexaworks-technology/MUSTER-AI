import type { Route } from "next";
import Link from "next/link";
import { formatCalendarDate } from "@/lib/format";
import { markPromiseKeptAction, setPromiseOwnerAction } from "@/modules/promises/actions/promises";
import type { PromiseRow } from "@/modules/promises/service";

const STATUS: Record<PromiseRow["status"], { label: string; cls: string }> = {
  LATE: { label: "Late", cls: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100" },
  BROKEN: { label: "Broken", cls: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100" },
  OPEN: { label: "Open", cls: "bg-muted text-foreground" },
  KEPT: {
    label: "Kept",
    cls: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  },
};
const PARTY = {
  US: "We promised",
  CUSTOMER: "The customer promised",
  UNCLEAR: "Not clear from the text",
} as const;

function sourceHref(accountId: string, s: { type: string; id: string }): Route | null {
  const base = `/accounts/${accountId}`;
  if (s.type === "CALL_TRANSCRIPT" || s.type === "MESSAGE") return `${base}/conversations` as Route;
  if (s.type === "NOTE") return `${base}/notes` as Route;
  return null;
}

/** The tracker's rows: status and reason first, the quote and its source beside every promise (Rule 1). */
export function PromiseTable({
  rows,
  owners,
  returnTo,
  canEdit,
  showAccount = true,
}: {
  rows: PromiseRow[];
  owners: Array<{ id: string; name: string }>;
  returnTo: string;
  canEdit: boolean;
  showAccount?: boolean;
}) {
  return (
    <ul
      className="divide-border border-border divide-y rounded-md border"
      data-testid="promise-list"
    >
      {rows.map((p) => {
        const href = p.source ? sourceHref(p.account.id, p.source) : null;
        return (
          <li
            key={p.id}
            id={`promise-${p.id}`}
            className="space-y-1 p-3 text-sm"
            data-testid="promise-row"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS[p.status].cls}`}
                data-testid="promise-status"
              >
                {STATUS[p.status].label}
              </span>
              <span className="font-medium">{p.what}</span>
              {showAccount ? (
                <Link href={`/accounts/${p.account.id}/promises` as Route} className="underline">
                  {p.account.name}
                </Link>
              ) : null}
              <span className="text-muted-foreground text-xs">
                {PARTY[p.party]}
                {p.party === "UNCLEAR" && p.suggestedParty
                  ? ` (the model suggests ${p.suggestedParty === "US" ? "us" : "the customer"})`
                  : ""}
                {" · "}
                {p.dueDate
                  ? `due ${formatCalendarDate(new Date(`${p.dueDate}T00:00:00Z`))}`
                  : "no due date"}
                {" · "}
                {p.owner ? `owner ${p.owner.name}` : "no owner"}
              </span>
            </div>
            <p className="text-muted-foreground">{p.statusReason}</p>
            {p.quote ? (
              <p className="text-xs">
                Said: <q>{p.quote}</q>{" "}
                {href ? (
                  <Link href={href} className="underline">
                    open the{" "}
                    {p.source!.type === "CALL_TRANSCRIPT"
                      ? "call"
                      : p.source!.type === "NOTE"
                        ? "note"
                        : "message"}
                  </Link>
                ) : null}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">Entered by hand.</p>
            )}
            {canEdit && p.status !== "KEPT" ? (
              <div className="flex flex-wrap items-end gap-4 pt-1">
                <form action={setPromiseOwnerAction} className="flex items-end gap-2 text-xs">
                  <input type="hidden" name="promiseId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label>
                    <span className="block">Owner</span>
                    <select
                      name="ownerMembershipId"
                      defaultValue={p.owner?.id ?? ""}
                      className="border-input bg-background mt-1 rounded-md border px-2 py-1 text-sm"
                    >
                      <option value="">No owner</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="rounded-md border px-2 py-1">
                    Save owner
                  </button>
                </form>
                <form action={markPromiseKeptAction} className="flex items-end gap-2 text-xs">
                  <input type="hidden" name="promiseId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label>
                    <span className="block">How it was kept (saved as a note)</span>
                    <input
                      name="text"
                      required
                      maxLength={500}
                      className="border-input bg-background mt-1 w-64 rounded-md border px-2 py-1 text-sm"
                    />
                  </label>
                  <button type="submit" className="rounded-md border px-2 py-1">
                    Mark kept
                  </button>
                </form>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
