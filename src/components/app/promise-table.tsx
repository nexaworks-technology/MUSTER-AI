import type { Route } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCalendarDate } from "@/lib/format";
import { markPromiseKeptAction, setPromiseOwnerAction } from "@/modules/promises/actions/promises";
import type { PromiseRow } from "@/modules/promises/service";

const STATUS: Record<
  PromiseRow["status"],
  { label: string; variant: "warning" | "danger" | "neutral" | "success" }
> = {
  LATE: { label: "Late", variant: "warning" },
  BROKEN: { label: "Broken", variant: "danger" },
  OPEN: { label: "Open", variant: "neutral" },
  KEPT: { label: "Kept", variant: "success" },
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
    <ul className="surface divide-border divide-y overflow-hidden" data-testid="promise-list">
      {rows.map((p) => {
        const href = p.source ? sourceHref(p.account.id, p.source) : null;
        return (
          <li
            key={p.id}
            id={`promise-${p.id}`}
            className="space-y-1 p-4 text-sm"
            data-testid="promise-row"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Badge variant={STATUS[p.status].variant} data-testid="promise-status">
                {STATUS[p.status].label}
              </Badge>
              <span className="font-medium">{p.what}</span>
              {showAccount ? (
                <Link
                  href={`/accounts/${p.account.id}/promises` as Route}
                  className="text-primary underline underline-offset-2"
                >
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
                  <Link href={href} className="text-primary underline underline-offset-2">
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
                    <NativeSelect
                      name="ownerMembershipId"
                      defaultValue={p.owner?.id ?? ""}
                      className="mt-1 h-8"
                    >
                      <option value="">No owner</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <Button type="submit" variant="outline" size="sm">
                    Save owner
                  </Button>
                </form>
                <form action={markPromiseKeptAction} className="flex items-end gap-2 text-xs">
                  <input type="hidden" name="promiseId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label>
                    <span className="block">How it was kept (saved as a note)</span>
                    <Input name="text" required maxLength={500} className="mt-1 h-8 w-64" />
                  </label>
                  <Button type="submit" variant="outline" size="sm">
                    Mark kept
                  </Button>
                </form>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
