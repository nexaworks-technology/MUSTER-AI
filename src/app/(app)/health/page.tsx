import type { Metadata, Route } from "next";
import Link from "next/link";
import { NativeSelect } from "@/components/app/native-select";
import { EmptyState } from "@/components/app/empty-state";
import { RecomputeButton } from "@/components/app/recompute-button";
import { DisagreementMark, RISK_WORDS, RiskBadge } from "@/components/app/risk-badge";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatArr, formatCalendarDate, RESTRICTED } from "@/lib/format";
import { accountListQuery, TIER_LABELS, TIERS } from "@/modules/accounts/schemas";
import { listAccounts, listOwners } from "@/modules/accounts/service";
import { healthForAccounts, healthOverview, type Band, type Mover } from "@/modules/health/service";
import { listSegments } from "@/modules/segments/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Health" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const BAND_ORDER: Band[] = ["AT_RISK", "WATCH", "HEALTHY", "INSUFFICIENT_DATA"];
const PULSE_WORDS = { FINE: "Actually fine", WORRIED: "Worried" } as const;
const day = (d: string) => formatCalendarDate(new Date(`${d}T00:00:00Z`));

function MoverList({ movers, empty }: { movers: Mover[]; empty: string }) {
  if (movers.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <ul className="surface divide-border divide-y overflow-hidden text-sm">
      {movers.map((m) => (
        <li key={m.accountId} className="space-y-1 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/accounts/${m.accountId}/health`} className="font-medium hover:underline">
              {m.name}
            </Link>
            <span className="tabular-nums">
              {m.from.overall?.toFixed(0) ?? "—"} → {m.to.overall?.toFixed(0) ?? "—"}
            </span>
            <span className="text-muted-foreground text-xs">
              {RISK_WORDS[m.from.riskLevel]} → {RISK_WORDS[m.to.riskLevel]}
            </span>
            <RiskBadge level={m.to.riskLevel} />
          </div>
          {m.topReason ? <p className="text-muted-foreground">{m.topReason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Health (spec §5): all accounts by health, what moved today/this week and why, disagreements. */
export default async function HealthPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [
      k,
      Array.isArray(v) ? (v[0] ?? "") : (v ?? ""),
    ]),
  );
  const parsed = accountListQuery.safeParse({ health: "AT_RISK", ...raw });
  const query = parsed.success ? parsed.data : accountListQuery.parse({ health: "AT_RISK" });
  const [overview, page, owners, segments] = await Promise.all([
    healthOverview(ctx),
    listAccounts(ctx, query),
    listOwners(ctx),
    listSegments(ctx),
  ]);
  const health = await healthForAccounts(
    ctx,
    page.rows.map((a) => a.id),
  );
  const currency = ctx.workspace.baseCurrency;
  const band = (query.health ?? "AT_RISK") as Band;
  const href = (q: Record<string, string>) =>
    `/health?${new URLSearchParams({ ...raw, ...q })}` as Route;

  return (
    <div className="space-y-section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
          <p className="text-muted-foreground text-sm">
            {overview.asOf ? `As of ${day(overview.asOf)}` : "Not calculated yet"} · Health model v
            {overview.model.version}
            {overview.model.proposedBy === "SYSTEM_DEFAULT"
              ? " (default weights — not yet back-tested on your accounts)"
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link
            href={"/health/sentiment" as Route}
            className="text-primary font-medium hover:underline"
            data-testid="sentiment-link"
          >
            Sentiment &amp; themes
          </Link>
          {" · "}
          <Link
            href={"/health/signals" as Route}
            className="text-primary font-medium hover:underline"
          >
            Signals
          </Link>
          {can(ctx, "healthModel:propose") ? (
            <RecomputeButton label="Recompute all accounts" />
          ) : null}
        </div>
      </div>

      <section aria-labelledby="bands" className="space-y-3">
        <h2 id="bands" className="sr-only">
          Accounts by health
        </h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BAND_ORDER.map((b) => (
            <li key={b}>
              <Link
                href={href({ health: b, cursor: "" })}
                aria-current={band === b ? "page" : undefined}
                className={cn(
                  "bg-card hover:bg-muted block space-y-1.5 rounded-lg border p-4 shadow-xs transition-colors",
                  band === b ? "border-primary ring-primary ring-1" : "border-border",
                )}
                data-testid={`band-${b}`}
              >
                <RiskBadge level={b} />
                <span className="block text-2xl font-semibold tabular-nums">
                  {overview.bands[b].count}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {overview.bands[b].arrMinor === null
                    ? `ARR ${RESTRICTED}`
                    : `ARR ${formatArr({ minor: overview.bands[b].arrMinor!, currency })}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {overview.unscored > 0 ? (
          <p className="text-muted-foreground text-xs">
            {overview.unscored} account{overview.unscored === 1 ? " has" : "s have"} not been scored
            yet.
          </p>
        ) : null}
      </section>

      <div className="gap-section grid lg:grid-cols-2">
        <section aria-labelledby="today" className="space-y-3">
          <h2 id="today" className="text-base font-semibold">
            Moved today
          </h2>
          <MoverList
            movers={overview.movers.today}
            empty="Nothing changed band or moved 10 points since yesterday."
          />
        </section>
        <section aria-labelledby="week" className="space-y-3">
          <h2 id="week" className="text-base font-semibold">
            Moved this week
          </h2>
          <MoverList
            movers={overview.movers.week}
            empty="Nothing changed band or moved 10 points in the last 7 days."
          />
        </section>
      </div>

      <section aria-labelledby="disagree" className="space-y-3">
        <h2 id="disagree" className="text-base font-semibold">
          Score and CSM disagree ({overview.disagreements.length})
        </h2>
        {overview.disagreements.length === 0 ? (
          <EmptyState>No disagreements: every CSM Pulse matches the numbers.</EmptyState>
        ) : (
          <ul
            className="surface divide-border divide-y overflow-hidden text-sm"
            data-testid="disagreements"
          >
            {overview.disagreements.map((d) => (
              <li key={d.accountId} className="space-y-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/accounts/${d.accountId}/health`}
                    className="font-medium hover:underline"
                  >
                    {d.name}
                  </Link>
                  <DisagreementMark />
                </div>
                <p>
                  The numbers say {RISK_WORDS[d.riskLevelExcludingPulse]} (
                  {d.overallExcludingPulse?.toFixed(0) ?? "—"}
                  );{" "}
                  {d.pulse
                    ? `${d.pulse.author} says ${PULSE_WORDS[d.pulse.value]}`
                    : "the CSM disagrees"}
                  {d.pulse?.comment ? `: "${d.pulse.comment}"` : ""}.
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="list" className="space-y-3">
        <h2 id="list" className="text-base font-semibold">
          {RISK_WORDS[band]} accounts
        </h2>
        <form
          method="get"
          className="surface flex flex-wrap items-end gap-3 p-4"
          role="search"
          aria-label="Filter accounts by health"
        >
          <input type="hidden" name="health" value={band} />
          <div className="space-y-1">
            <label htmlFor="h-owner" className="text-muted-foreground block text-xs">
              Owner
            </label>
            <NativeSelect id="h-owner" name="owner" defaultValue={query.owner ?? ""}>
              <option value="">Anyone</option>
              <option value="none">No owner</option>
              {owners.map((o) => (
                <option key={o.membershipId} value={o.membershipId}>
                  {o.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="h-tier" className="text-muted-foreground block text-xs">
              Tier
            </label>
            <NativeSelect id="h-tier" name="tier" defaultValue={query.tier ?? ""}>
              <option value="">All tiers</option>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="h-segment" className="text-muted-foreground block text-xs">
              Segment
            </label>
            <NativeSelect id="h-segment" name="segment" defaultValue={query.segment ?? ""}>
              <option value="">No segment</option>
              {segments
                .filter((s) => s.valid)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>
        {page.rows.length === 0 ? (
          <EmptyState>No {RISK_WORDS[band].toLowerCase()} accounts in your book.</EmptyState>
        ) : (
          <ul
            className="surface divide-border divide-y overflow-hidden text-sm"
            data-testid="band-accounts"
          >
            {page.rows.map((a) => {
              const h = health.get(a.id);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <Link href={`/accounts/${a.id}/health`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{h?.overall?.toFixed(0) ?? "—"}</span>
                    {h?.riskLevel ? <RiskBadge level={h.riskLevel} /> : null}
                    {h?.pulse?.valid ? (
                      <span className="text-muted-foreground text-xs">
                        Pulse: {PULSE_WORDS[h.pulse.value]}
                      </span>
                    ) : null}
                    {h?.pulseDisagreement ? <DisagreementMark /> : null}
                    <span className="text-muted-foreground text-xs">{TIER_LABELS[a.tier]}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <nav aria-label="Pages" className="text-primary flex gap-4 text-sm font-medium">
          {page.prevCursor !== null ? (
            <Link href={href({ cursor: page.prevCursor })} className="hover:underline">
              Previous
            </Link>
          ) : null}
          {page.nextCursor !== null ? (
            <Link href={href({ cursor: page.nextCursor })} className="hover:underline">
              Next
            </Link>
          ) : null}
        </nav>
      </section>
    </div>
  );
}
