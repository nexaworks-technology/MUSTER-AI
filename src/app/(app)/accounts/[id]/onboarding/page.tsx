import type { Metadata, Route } from "next";
import Link from "next/link";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCalendarDate } from "@/lib/format";
import {
  blockStepAction,
  createPlanAction,
  markStepDoneAction,
} from "@/modules/onboarding/actions/onboarding";
import { getAccountOnboarding, type HandoffSource } from "@/modules/onboarding/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Onboarding" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const date = (d: Date) => formatCalendarDate(d);

/** Where each kind of source opens (Rule 1: every handoff item links to its record). */
function sourceHref(accountId: string, s: HandoffSource): Route | null {
  const base = `/accounts/${accountId}`;
  switch (s.sourceType) {
    case "Contract":
      return `${base}/billing` as Route;
    case "Contact":
    case "StakeholderRole":
      return `${base}/people` as Route;
    case "Signal":
      return `${base}/signals` as Route;
    case "Note":
      return `${base}/notes` as Route;
    default:
      return null;
  }
}

const proofSchema = z.array(
  z.object({
    sourceType: z.string(),
    sourceId: z.string().optional(),
    value: z.union([z.number(), z.string(), z.null()]),
    date: z.string().nullable(),
  }),
);

/** The usage rows that proved a step done or value reached (D1, Rule 1), linked to Usage. */
function Proof({ accountId, evidence }: { accountId: string; evidence: unknown }) {
  const parsed = proofSchema.safeParse(evidence);
  if (!parsed.success || parsed.data.length === 0) return null;
  const rows = parsed.data;
  const day = (d: string) => formatCalendarDate(new Date(`${d}T00:00:00Z`));
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const summary = (["FeatureUsageDaily", "UsageDaily"] as const).flatMap((type) => {
    const of = rows.filter((r) => r.sourceType === type);
    if (of.length === 0) return [];
    const dates = of
      .map((r) => r.date)
      .filter((d): d is string => d !== null)
      .sort();
    const values = of.map((r) => Number(r.value)).filter((n) => Number.isFinite(n));
    const span = dates.length
      ? dates.length === 1
        ? ` on ${day(dates[0]!)}`
        : ` between ${day(dates[0]!)} and ${day(dates.at(-1)!)}`
      : "";
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const range = values.length ? (lo === hi ? people(lo) : `${lo}–${hi} people`) : "";
    return [
      type === "FeatureUsageDaily"
        ? `feature use on ${of.length} ${of.length === 1 ? "day" : "days"}${span}`
        : `${range} active on ${of.length} ${of.length === 1 ? "day" : "days"}${span}`,
    ];
  });
  return (
    <details className="text-muted-foreground text-xs" data-testid="proof">
      <summary className="cursor-pointer">Proof: {summary.join("; ")}</summary>
      <ul className="mt-1 list-disc pl-5">
        {rows.map((r, i) => (
          <li key={`${r.sourceId ?? "row"}-${i}`}>
            {r.sourceType === "FeatureUsageDaily" ? "Feature usage" : "Daily usage"}
            {r.date ? `, ${day(r.date)}` : ""}: {people(Number(r.value))}
          </li>
        ))}
      </ul>
      <p className="mt-1">
        <Link
          href={`/accounts/${accountId}/usage` as Route}
          className="text-primary underline underline-offset-2"
        >
          See these days in Usage
        </Link>
      </p>
    </details>
  );
}

/**
 * Account 360 › Onboarding (spec §6G1): the plan's steps with owners (us / customer) and dates,
 * how each done step was completed (a person, or a product event with its proof), time to value
 * against similar accounts, and the Sales handoff with a source link on every item.
 */
export default async function AccountOnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const q = await searchParams;
  const { ctx, account } = await loadAccount(id);
  const v = await getAccountOnboarding(ctx, account.id);
  const plan = v.plan;
  const today = new Date(`${v.asOf}T00:00:00Z`);

  return (
    <div className="space-y-section max-w-4xl">
      {one(q.ok) ? (
        <Alert role="status">
          <AlertDescription>{one(q.ok)}</AlertDescription>
        </Alert>
      ) : null}
      {one(q.error) ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{one(q.error)}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="onb-plan" className="space-y-3">
        <h2 id="onb-plan" className="text-base font-semibold">
          Onboarding plan
        </h2>
        {!plan ? (
          <div className="border-border bg-card space-y-3 rounded-lg border border-dashed p-5 text-sm">
            <p>No onboarding plan yet.</p>
            {v.canEdit ? (
              <form action={createPlanAction.bind(null, account.id)}>
                <Button type="submit">Start onboarding from the matching template</Button>
              </form>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-sm" data-testid="onboarding-status">
              {plan.template?.name ?? "Custom plan"} · started {date(plan.startDate)} ·{" "}
              {plan.status === "STALLED"
                ? `Stalled: ${plan.stallReason}`
                : plan.status === "COMPLETE"
                  ? `Value reached ${plan.valueReachedAt ? date(plan.valueReachedAt) : ""}`
                  : plan.status === "CANCELLED"
                    ? "Cancelled"
                    : "On track"}
            </p>
            {plan.status === "COMPLETE" ? (
              <Proof accountId={account.id} evidence={plan.valueEvidence} />
            ) : null}
            <p className="text-sm" data-testid="onboarding-ttv">
              {v.ttv ? v.ttv.reason : "No value definition for this plan"}
              {v.valueText ? (
                <span className="text-muted-foreground block text-xs">
                  First value means: {v.valueText}.
                </span>
              ) : null}
            </p>
            <ol className="surface divide-border divide-y overflow-hidden text-sm">
              {plan.steps.map((s) => {
                const overdue = !s.doneAt && s.dueDate < today;
                const who =
                  s.ownerSide === "US"
                    ? `Us${s.owner ? ` (${s.owner.user.name ?? s.owner.user.email})` : ""}`
                    : `Customer${s.ownerContact ? ` (${s.ownerContact.name})` : ""}`;
                return (
                  <li
                    key={s.id}
                    id={`step-${s.id}`}
                    className="space-y-1.5 p-4"
                    data-testid={`step-${s.key}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{s.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {who} · due {date(s.dueDate)}
                      </span>
                    </div>
                    <p className="text-sm">
                      {s.doneAt
                        ? s.completedVia === "PRODUCT_EVENT"
                          ? `Done ${date(s.doneAt)}: product usage showed it`
                          : `Done ${date(s.doneAt)} by ${s.completedBy?.user.name ?? s.completedBy?.user.email ?? "a member"}`
                        : overdue
                          ? `Overdue ${Math.round((today.getTime() - s.dueDate.getTime()) / 86_400_000)} days`
                          : "Open"}
                      {s.blockedReason ? ` · Blocked: ${s.blockedReason}` : ""}
                    </p>
                    {s.completedVia === "PRODUCT_EVENT" ? (
                      <Proof accountId={account.id} evidence={s.evidence} />
                    ) : null}
                    {!s.doneAt && v.canEdit && plan.status !== "COMPLETE" ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <form action={markStepDoneAction.bind(null, account.id, s.id)}>
                          <Button type="submit" size="sm" variant="outline">
                            Mark done
                          </Button>
                        </form>
                        <form
                          action={blockStepAction.bind(null, account.id, s.id)}
                          className="flex items-end gap-2"
                        >
                          <label className="flex flex-col text-xs">
                            Blocked by
                            <Input
                              name="blockedReason"
                              defaultValue={s.blockedReason ?? ""}
                              className="mt-1 h-8"
                            />
                          </label>
                          <Button type="submit" size="sm" variant="ghost">
                            Save
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      <section aria-labelledby="onb-handoff" className="space-y-3">
        <h2 id="onb-handoff" className="text-base font-semibold">
          Sales handoff
        </h2>
        <ul
          className="surface divide-border divide-y overflow-hidden text-sm"
          data-testid="handoff"
        >
          {v.handoff.items.map((item) => (
            <li key={item.key} className="space-y-1 p-4">
              <span className={item.found ? "" : "text-muted-foreground"}>{item.text}</span>
              {item.values?.length ? (
                <ul className="list-disc pl-5">
                  {item.values.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : null}
              {item.sources.length ? (
                <span className="text-muted-foreground block text-xs">
                  Source:{" "}
                  {item.sources.map((s, i) => {
                    const href = sourceHref(account.id, s);
                    return (
                      <span key={`${s.sourceType}-${s.sourceId}-${i}`}>
                        {i ? ", " : ""}
                        {href ? (
                          <Link href={href} className="text-primary underline underline-offset-2">
                            {s.label}
                          </Link>
                        ) : (
                          s.label
                        )}
                      </span>
                    );
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
