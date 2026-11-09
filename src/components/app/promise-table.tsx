import type { Route } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
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
    <DataListCard>
      <ul className="divide-border divide-y overflow-hidden" data-testid="promise-list">
        {rows.map((p) => {
          const href = p.source ? sourceHref(p.account.id, p.source) : null;
          return (
            <li
              key={p.id}
              id={`promise-${p.id}`}
              className="group p-4 text-sm hover:bg-muted/40 transition-colors space-y-2"
              data-testid="promise-row"
            >
              <div className="flex items-start gap-3.5">
                <DataListAvatar name={p.account.name} size="sm" className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill variant={STATUS[p.status].variant} size="sm" data-testid="promise-status">
                        {STATUS[p.status].label}
                      </StatusPill>
                      <span className="font-medium text-foreground">{p.what}</span>
                      {showAccount ? (
                        <Link
                          href={`/accounts/${p.account.id}/promises` as Route}
                          className="text-primary underline underline-offset-2 hover:text-primary/80 font-medium"
                        >
                          {p.account.name}
                        </Link>
                      ) : null}
                    </div>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {p.dueDate
                        ? `due ${formatCalendarDate(new Date(`${p.dueDate}T00:00:00Z`))}`
                        : "no due date"}
                    </span>
                  </div>

                  <p className="text-muted-foreground text-xs flex flex-wrap items-center gap-x-2">
                    <span>{PARTY[p.party]}</span>
                    {p.party === "UNCLEAR" && p.suggestedParty
                      ? <span>(the model suggests {p.suggestedParty === "US" ? "us" : "the customer"})</span>
                      : null}
                    <span>·</span>
                    <span>{p.owner ? `owner ${p.owner.name}` : "no owner"}</span>
                  </p>

                  <p className="text-muted-foreground text-xs leading-relaxed">{p.statusReason}</p>
                  {p.quote ? (
                    <p className="text-xs bg-muted/40 rounded-md p-2.5 border border-border/50 text-foreground">
                      Said: <q>{p.quote}</q>{" "}
                      {href ? (
                        <Link href={href} className="text-primary underline underline-offset-2 ml-1">
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
                    <div className="flex flex-wrap items-end gap-4 pt-2 border-t border-border/60">
                      <form action={setPromiseOwnerAction} className="flex items-end gap-2 text-xs">
                        <input type="hidden" name="promiseId" value={p.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <label>
                          <span className="block text-muted-foreground font-medium">Owner</span>
                          <NativeSelect
                            name="ownerMembershipId"
                            defaultValue={p.owner?.id ?? ""}
                            className="mt-1 h-8 text-xs"
                          >
                            <option value="">No owner</option>
                            {owners.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                        <Button type="submit" variant="outline" size="sm" className="h-8">
                          Save owner
                        </Button>
                      </form>
                      <form action={markPromiseKeptAction} className="flex items-end gap-2 text-xs">
                        <input type="hidden" name="promiseId" value={p.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <label>
                          <span className="block text-muted-foreground font-medium">How it was kept (saved as a note)</span>
                          <Input name="text" required maxLength={500} className="mt-1 h-8 w-64 text-xs" />
                        </label>
                        <Button type="submit" variant="outline" size="sm" className="h-8">
                          Mark kept
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </DataListCard>
  );
}
