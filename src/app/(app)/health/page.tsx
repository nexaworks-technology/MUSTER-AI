import type { Metadata, Route } from "next";
import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { NativeSelect } from "@/components/app/native-select";
import { EmptyState } from "@/components/app/empty-state";
import { RecomputeButton } from "@/components/app/recompute-button";
import { DisagreementMark, RISK_WORDS, RiskBadge } from "@/components/app/risk-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext, type WorkspaceContext } from "@/lib/auth/session";
import { addDays, calendarDateOf, todayIn, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { formatArr, formatCalendarDate, RESTRICTED } from "@/lib/format";
import { accountListQuery, TIER_LABELS, TIERS } from "@/modules/accounts/schemas";
import { bookWhere, listAccounts, listOwners } from "@/modules/accounts/service";
import {
  getActiveModel,
  healthForAccounts,
  healthOverview,
  listUnscoredAccounts,
  liveSnapshotWhere,
  UNSCORED_LIST_LIMIT,
  type Band,
  type Mover,
} from "@/modules/health/service";
import { portfolioHealthTrend } from "@/modules/reports/service";
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
    <ul className="surface rounded-xl border border-border/80 shadow-xs divide-y divide-border/40 overflow-hidden text-sm">
      {movers.map((m) => (
        <li key={m.accountId} className="space-y-1.5 p-4 hover:bg-muted/30 transition-colors">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/accounts/${m.accountId}/health`}
              className="font-medium text-foreground hover:text-primary hover:underline"
            >
              {m.name}
            </Link>
            <span className="tabular-nums text-xs font-semibold text-foreground">
              {m.from.overall?.toFixed(0) ?? "—"} → {m.to.overall?.toFixed(0) ?? "—"}
            </span>
            <span className="text-muted-foreground text-xs">
              {RISK_WORDS[m.from.riskLevel]} → {RISK_WORDS[m.to.riskLevel]}
            </span>
            <RiskBadge level={m.to.riskLevel} />
          </div>
          {m.topReason ? <p className="text-muted-foreground text-xs">{m.topReason}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Loads real portfolio-health-trend data using the pure computation and live snapshots.
 * No new metrics, no invented history.
 */
async function loadPortfolioHealthTrend(ctx: WorkspaceContext) {
  const db = scopedDb(ctx);
  const model = await getActiveModel(ctx);
  const today = todayIn(ctx.workspace.timezone);
  const start = addDays(today, -28); // 4-week window ending today
  const grantScope = ctx.role === "ADMIN" || ctx.role === "CS_LEADER" ? "ALL" : ctx.bookScope;

  const accounts = await db.account.findMany({
    where: {
      AND: [bookWhere(ctx, grantScope), { archivedAt: null, lifecycleStage: { not: "LOST" } }],
    },
    select: {
      id: true,
      arrMinor: true,
      arrCurrency: true,
      currentHealth: {
        select: {
          id: true,
          healthModelId: true,
          riskLevel: true,
        },
      },
    },
  });

  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return null;

  const snaps = await db.healthScoreSnapshot.findMany({
    where: liveSnapshotWhere({
      accountId: { in: ids },
      healthModelId: model.id,
      asOf: { gte: utcMidnight(addDays(start, -7)), lte: utcMidnight(today) },
    }),
    select: { id: true, accountId: true, asOf: true, riskLevel: true },
  });

  const report = portfolioHealthTrend({
    periodStart: start,
    periodEnd: today,
    baseCurrency: ctx.workspace.baseCurrency,
    query: "",
    accounts: accounts.map((a) => {
      const h = a.currentHealth?.healthModelId === model.id ? a.currentHealth : null;
      return {
        id: a.id,
        arrMinor: a.arrMinor,
        currency: a.arrCurrency,
        currentSnapshotId: h?.id ?? null,
        currentRisk: h?.riskLevel ?? null,
      };
    }),
    snapshots: snaps.map((x) => ({
      id: x.id,
      accountId: x.accountId,
      asOf: calendarDateOf(x.asOf),
      riskLevel: x.riskLevel,
    })),
  });

  // Extract weekly series figures
  const seriesSection = report.sections.find((s) => s.title.startsWith("Accounts per band"));
  const movementSection = report.sections.find((s) => s.title === "Movement over the period");

  return {
    report,
    series: seriesSection?.figures ?? [],
    movement: movementSection?.figures ?? [],
    periodStart: start,
    periodEnd: today,
  };
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
  const [overview, page, owners, segments, trend, unscoredAccounts] = await Promise.all([
    healthOverview(ctx),
    listAccounts(ctx, query),
    listOwners(ctx),
    listSegments(ctx),
    loadPortfolioHealthTrend(ctx),
    listUnscoredAccounts(ctx),
  ]);
  const health = await healthForAccounts(
    ctx,
    page.rows.map((a) => a.id),
  );
  const currency = ctx.workspace.baseCurrency;
  const band = (query.health ?? "AT_RISK") as Band;
  const href = (q: Record<string, string>) =>
    `/health?${new URLSearchParams({ ...raw, ...q })}` as Route;

  // Band distribution calculations from existing counts
  const bandCounts = {
    HEALTHY: overview.bands.HEALTHY.count,
    WATCH: overview.bands.WATCH.count,
    AT_RISK: overview.bands.AT_RISK.count,
    INSUFFICIENT_DATA: overview.bands.INSUFFICIENT_DATA.count,
  };
  const totalScoredAccounts =
    bandCounts.HEALTHY + bandCounts.WATCH + bandCounts.AT_RISK + bandCounts.INSUFFICIENT_DATA;

  // Process weekly points for trend chart from existing figures
  const weeklyDates: string[] = [];
  const weeklyData = new Map<string, { healthy: number; watch: number; atRisk: number }>();
  if (trend) {
    for (const f of trend.series) {
      const match = f.label.match(/^(Healthy|Watch|At Risk) on (\d{4}-\d{2}-\d{2})$/);
      if (match && match[1] && match[2]) {
        const bandName = match[1];
        const dateStr = match[2];
        if (!weeklyData.has(dateStr)) {
          weeklyDates.push(dateStr);
          weeklyData.set(dateStr, { healthy: 0, watch: 0, atRisk: 0 });
        }
        const point = weeklyData.get(dateStr)!;
        const val = typeof f.value === "number" ? f.value : 0;
        if (bandName === "Healthy") point.healthy = val;
        else if (bandName === "Watch") point.watch = val;
        else if (bandName === "At Risk") point.atRisk = val;
      }
    }
  }

  return (
    <div className="space-y-section">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Health</h1>
          <p className="text-muted-foreground text-xs">
            {overview.asOf ? `As of ${day(overview.asOf)}` : "Not calculated yet"} · Health model v
            {overview.model.version}
            {overview.model.proposedBy === "SYSTEM_DEFAULT"
              ? " (default weights — not yet back-tested on your accounts)"
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Link
            href={"/health/sentiment" as Route}
            className="text-primary font-medium hover:underline"
            data-testid="sentiment-link"
          >
            Sentiment &amp; themes
          </Link>
          <span className="text-muted-foreground/60">·</span>
          <Link
            href={"/health/signals" as Route}
            className="text-primary font-medium hover:underline"
          >
            Signals
          </Link>
          {can(ctx, "healthModel:propose") ? (
            <>
              <span className="text-muted-foreground/60">·</span>
              <RecomputeButton label="Recompute all accounts" />
            </>
          ) : null}
        </div>
      </div>

      {/* R2: Band Cards adopt the Today KPI Pattern */}
      <section aria-labelledby="bands" className="space-y-3">
        <h2 id="bands" className="sr-only">
          Accounts by health
        </h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BAND_ORDER.map((b) => {
            const isSelected = band === b;
            return (
              <li key={b}>
                <Link
                  href={href({ health: b, cursor: "" })}
                  aria-current={isSelected ? "page" : undefined}
                  className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`band-${b}`}
                >
                  <Card
                    className={cn(
                      "surface-interactive h-full p-4 transition-all duration-150 rounded-xl",
                      isSelected
                        ? "border-primary ring-2 ring-primary/80 bg-primary/[0.02]"
                        : "border-border/80 hover:border-primary/40",
                    )}
                  >
                    <CardContent className="space-y-2 p-0">
                      <div className="flex items-center justify-between">
                        <RiskBadge level={b} />
                      </div>
                      <div className="text-foreground text-2xl sm:text-3xl font-bold tracking-tight tabular-nums">
                        {overview.bands[b].count}
                      </div>
                      <p className="text-muted-foreground truncate text-xs tabular-nums">
                        {overview.bands[b].arrMinor === null
                          ? `ARR ${RESTRICTED}`
                          : `ARR ${formatArr({ minor: overview.bands[b].arrMinor!, currency })}`}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
        {unscoredAccounts.length > 0 ? (
          <details
            className="surface px-4 py-3 text-sm"
            open={unscoredAccounts.length <= 15}
            data-testid="not-scored"
          >
            <summary className="cursor-pointer font-medium">
              Not scored ({unscoredAccounts.length}){" "}
              <span className="text-muted-foreground font-normal">
                · these accounts are in no band above; the reason is beside each
              </span>
            </summary>
            <ul className="divide-border mt-3 divide-y">
              {unscoredAccounts.map((u) => (
                <li
                  key={u.accountId}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                  data-testid="not-scored-row"
                >
                  <Link
                    href={`/accounts/${u.accountId}` as Route}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {u.name}
                  </Link>
                  <span className="text-muted-foreground max-w-prose text-xs">
                    {u.kind === "LOST" ? "Lost" : "Awaiting first score"}
                    {u.churnedAt ? ` (${formatCalendarDate(new Date(`${u.churnedAt}T00:00:00Z`))})` : ""}
                    {" · "}
                    {u.reason}
                  </span>
                </li>
              ))}
            </ul>
            {unscoredAccounts.length >= UNSCORED_LIST_LIMIT ? (
              <p className="text-muted-foreground mt-2 text-xs">
                Showing the first {UNSCORED_LIST_LIMIT}.
              </p>
            ) : null}
          </details>
        ) : null}
      </section>

      {/* R2: Band Distribution Bar & Portfolio Trend Chart Row */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Band Distribution Bar */}
        <Card className="rounded-xl border border-border/80 shadow-xs p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Band Distribution
            </h3>
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {totalScoredAccounts} accounts scored
            </span>
          </div>

          {totalScoredAccounts > 0 ? (
            <div className="space-y-3">
              {/* Stacked percentage bar */}
              <div
                className="h-3 w-full rounded-full bg-muted/60 overflow-hidden flex p-0.5 gap-0.5"
                role="img"
                aria-label={`Health distribution: ${bandCounts.HEALTHY} healthy, ${bandCounts.WATCH} watch, ${bandCounts.AT_RISK} at risk`}
              >
                {bandCounts.HEALTHY > 0 ? (
                  <div
                    style={{
                      width: `${(bandCounts.HEALTHY / totalScoredAccounts) * 100}%`,
                    }}
                    className="h-full bg-risk-healthy rounded-xs transition-all duration-300"
                    title={`Healthy: ${bandCounts.HEALTHY}`}
                  />
                ) : null}
                {bandCounts.WATCH > 0 ? (
                  <div
                    style={{
                      width: `${(bandCounts.WATCH / totalScoredAccounts) * 100}%`,
                    }}
                    className="h-full bg-risk-watch rounded-xs transition-all duration-300"
                    title={`Watch: ${bandCounts.WATCH}`}
                  />
                ) : null}
                {bandCounts.AT_RISK > 0 ? (
                  <div
                    style={{
                      width: `${(bandCounts.AT_RISK / totalScoredAccounts) * 100}%`,
                    }}
                    className="h-full bg-risk-at-risk rounded-xs transition-all duration-300"
                    title={`At Risk: ${bandCounts.AT_RISK}`}
                  />
                ) : null}
                {bandCounts.INSUFFICIENT_DATA > 0 ? (
                  <div
                    style={{
                      width: `${(bandCounts.INSUFFICIENT_DATA / totalScoredAccounts) * 100}%`,
                    }}
                    className="h-full bg-muted-foreground/30 rounded-xs transition-all duration-300"
                    title={`Not enough data: ${bandCounts.INSUFFICIENT_DATA}`}
                  />
                ) : null}
              </div>

              {/* Legend with exact counts & percentages */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-risk-healthy shrink-0" />
                  <span className="text-muted-foreground">Healthy:</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {bandCounts.HEALTHY}{" "}
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({Math.round((bandCounts.HEALTHY / totalScoredAccounts) * 100)}%)
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-risk-watch shrink-0" />
                  <span className="text-muted-foreground">Watch:</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {bandCounts.WATCH}{" "}
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({Math.round((bandCounts.WATCH / totalScoredAccounts) * 100)}%)
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-risk-at-risk shrink-0" />
                  <span className="text-muted-foreground">At Risk:</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {bandCounts.AT_RISK}{" "}
                    <span className="text-[11px] font-normal text-muted-foreground">
                      ({Math.round((bandCounts.AT_RISK / totalScoredAccounts) * 100)}%)
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-muted-foreground/40 shrink-0" />
                  <span className="text-muted-foreground">No data:</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {bandCounts.INSUFFICIENT_DATA}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No scored accounts in this book.</p>
          )}
        </Card>

        {/* Portfolio Trend Chart from portfolio-health-trend data */}
        <Card className="rounded-xl border border-border/80 shadow-xs p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" />
              <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Portfolio Trend (30 Days)
              </h3>
            </div>
            {trend && (
              <span className="text-muted-foreground text-[11px]">
                {trend.periodStart} to {trend.periodEnd}
              </span>
            )}
          </div>

          {weeklyDates.length > 0 ? (
            <div className="space-y-2.5">
              {/* Stacked columns for weekly points */}
              <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 pt-1 items-end h-28">
                {weeklyDates.map((dateStr) => {
                  const pt = weeklyData.get(dateStr)!;
                  const total = pt.healthy + pt.watch + pt.atRisk;
                  const maxAccounts = Math.max(
                    1,
                    ...Array.from(weeklyData.values()).map((p) => p.healthy + p.watch + p.atRisk),
                  );
                  const colHeightPercent = Math.max(15, (total / maxAccounts) * 100);

                  return (
                    <div key={dateStr} className="flex flex-col items-center gap-1.5 h-full justify-end">
                      <div
                        className="w-full max-w-10 rounded-md overflow-hidden flex flex-col justify-end bg-muted/40 p-0.5 gap-0.5 transition-all"
                        style={{ height: `${colHeightPercent}%` }}
                        title={`${dateStr}: ${pt.healthy} healthy, ${pt.watch} watch, ${pt.atRisk} at risk`}
                      >
                        {pt.healthy > 0 ? (
                          <div
                            style={{ flex: pt.healthy }}
                            className="w-full bg-risk-healthy/90 rounded-xs"
                          />
                        ) : null}
                        {pt.watch > 0 ? (
                          <div
                            style={{ flex: pt.watch }}
                            className="w-full bg-risk-watch/90 rounded-xs"
                          />
                        ) : null}
                        {pt.atRisk > 0 ? (
                          <div
                            style={{ flex: pt.atRisk }}
                            className="w-full bg-risk-at-risk/90 rounded-xs"
                          />
                        ) : null}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium tabular-nums whitespace-nowrap">
                        {dateStr.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Movement over period notes */}
              {trend?.movement && trend.movement.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between text-[11px] border-t border-border/40 pt-2 text-muted-foreground">
                  <div className="flex items-center gap-3">
                    {trend.movement.map((m) => (
                      <span key={m.label} className="tabular-nums">
                        {m.label}: <strong className="text-foreground">{m.value ?? "—"}</strong>
                      </span>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">Weekly snapshot points</span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs py-4">
              Health snapshots are computed nightly; weekly trend points will appear here.
            </p>
          )}
        </Card>
      </div>

      {/* Moved Today & Moved This Week */}
      <div className="gap-section grid lg:grid-cols-2">
        <section aria-labelledby="today" className="space-y-3">
          <h2 id="today" className="text-base font-semibold text-foreground">
            Moved today
          </h2>
          <MoverList
            movers={overview.movers.today}
            empty="Nothing changed band or moved 10 points since yesterday."
          />
        </section>
        <section aria-labelledby="week" className="space-y-3">
          <h2 id="week" className="text-base font-semibold text-foreground">
            Moved this week
          </h2>
          <MoverList
            movers={overview.movers.week}
            empty="Nothing changed band or moved 10 points in the last 7 days."
          />
        </section>
      </div>

      {/* Score and CSM disagree */}
      <section aria-labelledby="disagree" className="space-y-3">
        <h2 id="disagree" className="text-base font-semibold text-foreground">
          Score and CSM disagree ({overview.disagreements.length})
        </h2>
        {overview.disagreements.length === 0 ? (
          <EmptyState>No disagreements: every CSM Pulse matches the numbers.</EmptyState>
        ) : (
          <ul
            className="surface rounded-xl border border-border/80 shadow-xs divide-y divide-border/40 overflow-hidden text-sm"
            data-testid="disagreements"
          >
            {overview.disagreements.map((d) => (
              <li key={d.accountId} className="space-y-1.5 p-4 hover:bg-muted/30 transition-colors">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/accounts/${d.accountId}/health`}
                    className="font-medium text-foreground hover:text-primary hover:underline"
                  >
                    {d.name}
                  </Link>
                  <DisagreementMark />
                </div>
                <p className="text-xs text-muted-foreground">
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

      {/* Accounts in selected band */}
      <section aria-labelledby="list" className="space-y-3">
        <h2 id="list" className="text-base font-semibold text-foreground">
          {RISK_WORDS[band]} accounts
        </h2>
        <form
          method="get"
          className="surface rounded-xl border border-border/80 p-4 shadow-xs flex flex-wrap items-end gap-3"
          role="search"
          aria-label="Filter accounts by health"
        >
          <input type="hidden" name="health" value={band} />
          <div className="space-y-1">
            <label htmlFor="h-owner" className="text-muted-foreground block text-xs font-medium">
              Owner
            </label>
            <NativeSelect id="h-owner" name="owner" defaultValue={query.owner ?? ""} className="h-8 text-xs">
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
            <label htmlFor="h-tier" className="text-muted-foreground block text-xs font-medium">
              Tier
            </label>
            <NativeSelect id="h-tier" name="tier" defaultValue={query.tier ?? ""} className="h-8 text-xs">
              <option value="">All tiers</option>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="h-segment" className="text-muted-foreground block text-xs font-medium">
              Segment
            </label>
            <NativeSelect id="h-segment" name="segment" defaultValue={query.segment ?? ""} className="h-8 text-xs">
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
          <Button type="submit" variant="outline" size="sm" className="h-8 shadow-2xs font-medium">
            Apply
          </Button>
        </form>

        {page.rows.length === 0 ? (
          <EmptyState>No {RISK_WORDS[band].toLowerCase()} accounts in your book.</EmptyState>
        ) : (
          <ul
            className="surface rounded-xl border border-border/80 shadow-xs divide-y divide-border/40 overflow-hidden text-sm"
            data-testid="band-accounts"
          >
            {page.rows.map((a) => {
              const h = health.get(a.id);
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-muted/30 transition-colors"
                >
                  <Link
                    href={`/accounts/${a.id}/health`}
                    className="font-medium text-foreground hover:text-primary hover:underline text-xs sm:text-sm"
                  >
                    {a.name}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2.5">
                    <span className="tabular-nums text-xs font-semibold text-foreground">
                      {h?.overall?.toFixed(0) ?? "—"}
                    </span>
                    {h?.riskLevel ? <RiskBadge level={h.riskLevel} /> : null}
                    {h?.pulse?.valid ? (
                      <span className="text-muted-foreground text-xs">
                        Pulse: {PULSE_WORDS[h.pulse.value]}
                      </span>
                    ) : null}
                    {h?.pulseDisagreement ? <DisagreementMark /> : null}
                    <span className="text-muted-foreground text-xs font-normal">
                      {TIER_LABELS[a.tier]}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <nav
          aria-label="Pages"
          className="flex items-center justify-between border-t border-border/60 pt-4 text-xs font-medium text-muted-foreground"
        >
          <div>
            {page.total > 0
              ? `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`
              : null}
          </div>
          <div className="flex items-center gap-3">
            {page.prevCursor !== null ? (
              <Link
                href={href({ cursor: page.prevCursor })}
                className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
              >
                <span>← Previous</span>
              </Link>
            ) : null}
            {page.nextCursor !== null ? (
              <Link
                href={href({ cursor: page.nextCursor })}
                className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
              >
                <span>Next →</span>
              </Link>
            ) : null}
          </div>
        </nav>
      </section>
    </div>
  );
}
