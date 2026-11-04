import type { Route } from "next";
import Link from "next/link";
import { formatCalendarDate } from "@/lib/format";
import {
  exportOpportunityAction,
  updateOpportunityAction,
} from "@/modules/expansion/actions/expansion";
import {
  STATUS_WORDS,
  STATUSES,
  type OpportunityRow,
  type Whitespace,
} from "@/modules/expansion/service";

/** Money is never in a whitespace figure: it comes from `estimate.ts` or not at all. */
export function WhitespacePanel({ ws }: { ws: Whitespace }) {
  return (
    <div className="space-y-2 text-sm" data-testid="whitespace">
      <div>
        <h4 className="font-medium">Seat headroom</h4>
        {ws.seats.state === "NO_DATA" ? (
          <p className="text-muted-foreground">{ws.seats.reason}.</p>
        ) : (
          <p data-testid="seat-headroom">
            {ws.seats.inUse} people used the product in the last 28 days on {ws.seats.purchased}{" "}
            seats:{" "}
            {ws.seats.headroom >= 0
              ? `${ws.seats.headroom} seats of headroom.`
              : `${-ws.seats.headroom} seats over the limit.`}
          </p>
        )}
      </div>
      <div>
        <h4 className="font-medium">Plan features not in use</h4>
        {ws.features.state === "NO_DATA" ? (
          <p className="text-muted-foreground">{ws.features.reason}.</p>
        ) : ws.features.unused.length === 0 ? (
          <p>
            All {ws.features.total} key features in the plan were used in the last{" "}
            {ws.features.windowDays} days.
          </p>
        ) : (
          <ul className="list-disc pl-5">
            {ws.features.unused.map((f) => (
              <li key={f.featureKey}>
                {f.label}:{" "}
                {f.lastUsed
                  ? `last used ${formatCalendarDate(new Date(`${f.lastUsed}T00:00:00Z`))} (${f.daysQuiet} days ago)`
                  : "no use in the data"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function OpportunityControl({
  row,
  returnTo,
  members,
}: {
  row: OpportunityRow;
  returnTo: string;
  members: Array<{ id: string; name: string }>;
}) {
  return (
    <form
      action={updateOpportunityAction.bind(null, returnTo, row.id)}
      className="flex flex-wrap items-end gap-2 text-sm"
    >
      <label className="flex flex-col gap-1">
        Status
        <select
          name="status"
          defaultValue={row.status}
          className="border-input rounded-md border px-2 py-1"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_WORDS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Next step
        <input
          name="nextStep"
          defaultValue={row.nextStep ?? ""}
          maxLength={300}
          className="border-input rounded-md border px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1">
        By
        <input
          type="date"
          name="nextStepDate"
          defaultValue={row.nextStepDate ? row.nextStepDate.toISOString().slice(0, 10) : ""}
          className="border-input rounded-md border px-2 py-1"
        />
      </label>
      {members.length ? (
        <label className="flex flex-col gap-1">
          Owner
          <select
            name="owner"
            defaultValue={row.ownerMembershipId ?? ""}
            className="border-input rounded-md border px-2 py-1"
          >
            <option value="">No owner</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="submit" className="border-input rounded-md border px-3 py-1">
        Save
      </button>
    </form>
  );
}

export function OpportunityCard({
  row,
  returnTo,
  members,
  crmName,
  showAccount,
}: {
  row: OpportunityRow;
  returnTo: string;
  members: Array<{ id: string; name: string }>;
  crmName: string | null;
  showAccount: boolean;
}) {
  return (
    <article
      className="border-border space-y-2 rounded-md border p-3"
      data-testid={`opportunity-${row.account.name}`}
      aria-label={`Expansion opportunity: ${row.account.name}`}
    >
      <h3 className="font-medium">
        {showAccount ? (
          <Link href={`/accounts/${row.account.id}/expansion` as Route} className="underline">
            {row.account.name}
          </Link>
        ) : (
          `Opportunity (${STATUS_WORDS[row.status]})`
        )}
        {showAccount ? (
          <span className="text-muted-foreground"> · {STATUS_WORDS[row.status]}</span>
        ) : null}
      </h3>
      <p className="text-sm" data-testid="estimate">
        {!row.moneyVisible ? "Estimate: Restricted" : row.estimateText}
      </p>
      <div>
        <h4 className="text-sm font-medium">Why it is here</h4>
        <ul className="list-disc pl-5 text-sm">
          {row.signals.map((s) => (
            <li key={s.id}>
              <Link href={`/accounts/${row.account.id}/signals` as Route} className="underline">
                {s.title}
              </Link>
              {s.live ? "" : " (cleared)"}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-xs">
        Owner {row.owner ?? "none"} · Next step{" "}
        {row.nextStep
          ? `${row.nextStep}${row.nextStepDate ? ` by ${formatCalendarDate(row.nextStepDate)}` : ""}`
          : "none set"}
        {row.crmExternalId ? ` · In the CRM as ${row.crmExternalId}` : ""}
      </p>
      {row.whitespace ? (
        <details>
          <summary className="cursor-pointer text-xs underline">Whitespace</summary>
          <div className="mt-2">
            <WhitespacePanel ws={row.whitespace} />
          </div>
        </details>
      ) : null}
      {row.canEdit ? (
        <details>
          <summary className="cursor-pointer text-xs underline">Update</summary>
          <div className="mt-2">
            <OpportunityControl row={row} returnTo={returnTo} members={members} />
          </div>
        </details>
      ) : null}
      {row.canExport && crmName ? (
        <form action={exportOpportunityAction.bind(null, returnTo, row.id)}>
          <button type="submit" className="border-input rounded-md border px-3 py-1 text-sm">
            Export to {crmName}
          </button>
        </form>
      ) : null}
    </article>
  );
}
