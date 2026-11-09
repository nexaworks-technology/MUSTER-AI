import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AiText } from "@/components/app/ai-text";
import { EmptyState } from "@/components/app/empty-state";
import { LineChart } from "@/components/app/line-chart";
import { PulseControls } from "@/components/app/pulse-controls";
import { RecomputeButton } from "@/components/app/recompute-button";
import { DisagreementMark, RISK_WORDS, RiskBadge } from "@/components/app/risk-badge";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { healthNarrative } from "@/modules/agents/service";
import { getAccountHealth, type AccountHealth } from "@/modules/health/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Health" };

/**
 * Account 360 › Health (spec §6C1–C2, §6C5). Every number opens into its reasons; every reason
 * names its value, baseline, period and the records it read, each a link (M3 rule 2).
 */
const PILLARS = [
  ["ADOPTION", "Adoption"],
  ["ENGAGEMENT", "Engagement"],
  ["SUPPORT", "Support"],
  ["RELATIONSHIP", "Relationship"],
  ["COMMERCIAL", "Commercial"],
  ["SENTIMENT", "Sentiment"],
] as const;

const PULSE_WORDS = { FINE: "Actually fine", WORRIED: "Worried" } as const;
const day = (d: string) => formatCalendarDate(new Date(`${d}T00:00:00Z`));
/** Inputs stored as ratios are shown as percentages. */
const RATIOS = new Set([
  "active_rate",
  "seats_used_28d",
  "key_features_used_28d",
  "power_users_active_14d",
  "email_reply_rate_90d",
  "contraction_12m",
]);
const show = (input: string, x: number) =>
  RATIOS.has(input) ? `${Math.round(x * 100)}%` : String(Math.round(x * 10) / 10);
const pts = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)} pts`;

type Reason = NonNullable<AccountHealth["snapshot"]>["reasons"][number];

function ReasonItem({ r, main, linked }: { r: Reason; main: boolean; linked: boolean }) {
  const facts = [
    r.value !== null ? `value ${show(r.input, r.value)}` : null,
    r.baseline !== null ? `baseline ${show(r.input, r.baseline)}` : null,
    r.cohortValue !== null && r.cohortSize !== null
      ? `compared with ${r.cohortSize} accounts like this one (${show(r.input, r.cohortValue)})`
      : null,
    r.periodStart && r.periodEnd ? `${day(r.periodStart)} – ${day(r.periodEnd)}` : null,
    r.kind === "EVIDENCE" ? `impact ${pts(r.impact)}` : null,
  ].filter(Boolean);
  return (
    <li
      id={`reason-${r.id}`}
      className={`scroll-mt-20 space-y-1.5 p-4 transition-colors ${linked ? "bg-muted/70" : "hover:bg-muted/30"}`}
      data-testid="health-reason"
      data-kind={r.kind}
      aria-current={linked ? "true" : undefined}
    >
      <p className={r.kind === "MISSING_DATA" ? "text-muted-foreground text-xs" : "text-xs font-normal"}>
        {main ? <span className="font-semibold text-foreground">Main reason: </span> : null}
        {r.message}
      </p>
      {facts.length ? <p className="text-muted-foreground text-[11px]">{facts.join(" · ")}</p> : null}
      {r.sources.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Sources">
          {r.sources.map((s, i) => (
            <li key={i}>
              {s.href ? (
                <a href={s.href} className="text-primary underline underline-offset-2">
                  {s.label}
                </a>
              ) : (
                <span className="text-muted-foreground">{s.label}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function HealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const linkedRaw = (await searchParams).reason;
  const linked = Array.isArray(linkedRaw) ? linkedRaw[0] : linkedRaw;
  const { ctx, account } = await loadAccount(id);
  const [health, narrative] = await Promise.all([
    getAccountHealth(ctx, account.id),
    healthNarrative(ctx, account.id),
  ]);
  if (!health) notFound();
  const { snapshot: s, pulse, model, history } = health;
  const tz = ctx.workspace.timezone;

  return (
    <div className="space-y-section">
      {/* Health Score Overview Card */}
      <section
        aria-labelledby="health-score"
        className="surface rounded-xl border border-border/80 p-5 shadow-xs space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 id="health-score" className="text-base font-semibold text-foreground">
            Health
          </h2>
          {account.canEdit ? <RecomputeButton accountId={account.id} /> : null}
        </div>
        {!s ? (
          <EmptyState data-testid="no-health">
            Health has not been calculated for this account yet. It is calculated every night and
            whenever someone presses Recompute.
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-center gap-3.5">
            <span
              className="text-4xl font-bold tracking-tight tabular-nums text-foreground"
              data-testid="health-overall"
            >
              {s.overall === null ? "—" : s.overall.toFixed(0)}
            </span>
            <RiskBadge level={s.riskLevel} />
            {s.pulseDisagreement ? <DisagreementMark /> : null}
            <span className="text-muted-foreground text-xs">
              as of {day(s.asOf)} · Health model v{model.version}
              {model.proposedBy === "SYSTEM_DEFAULT"
                ? " (default weights — not yet back-tested on your accounts)"
                : ""}
            </span>
          </div>
        )}
        {s && s.riskReasonId ? (
          <p className="text-xs bg-muted/30 border border-border/60 rounded-lg p-3">
            <span className="font-semibold text-foreground">Why At Risk: </span>
            <span className="text-muted-foreground">
              {s.reasons.find((r) => r.id === s.riskReasonId)?.message}
            </span>
          </p>
        ) : null}
      </section>

      {/* CSM Pulse Card */}
      <section
        id="pulse"
        aria-labelledby="pulse-heading"
        className="surface rounded-xl border border-border/80 p-5 shadow-xs space-y-3.5"
      >
        <h2 id="pulse-heading" className="text-base font-semibold text-foreground">
          CSM Pulse
        </h2>
        {pulse ? (
          <p className="text-xs" data-testid="pulse">
            <span className="font-semibold text-foreground">{PULSE_WORDS[pulse.value]}</span>
            {pulse.comment ? ` — "${pulse.comment}"` : ""} · {pulse.author},{" "}
            {formatDateTime(pulse.createdAt, tz)}
            {pulse.valid ? "" : " (older than 30 days, no longer counted)"}
          </p>
        ) : (
          <EmptyState>No Pulse yet.</EmptyState>
        )}
        {s?.pulseDisagreement && pulse ? (
          <p className="text-xs text-muted-foreground bg-accent/20 border border-accent/30 rounded-lg p-3" data-testid="disagreement-detail">
            The numbers say {RISK_WORDS[s.riskLevelExcludingPulse]} (
            {s.overallExcludingPulse?.toFixed(0)} without the Pulse); {pulse.author} says{" "}
            {PULSE_WORDS[pulse.value]}. Both are shown; neither replaces the other.
          </p>
        ) : null}
        {account.canEdit ? <PulseControls accountId={account.id} /> : null}
      </section>

      {/* Narrative Card */}
      <section
        aria-labelledby="narrative-heading"
        className="surface rounded-xl border border-border/80 p-5 shadow-xs space-y-3"
        data-testid="health-narrative"
      >
        <h2 id="narrative-heading" className="text-base font-semibold text-foreground">
          What the Health Analyst sees
        </h2>
        {!narrative.configured && !narrative.run ? (
          <p className="text-muted-foreground text-xs" data-testid="ai-not-configured">
            AI is not configured. The scores and reasons below are computed without AI.
          </p>
        ) : narrative.run ? (
          <AiText
            run={narrative.run}
            items={narrative.items}
            emptyText={`Nothing here needs action. ${narrative.reasoningSummary ?? ""}`.trim()}
          />
        ) : (
          <EmptyState>
            No narrative yet. One is written when the band or the main reason changes.
          </EmptyState>
        )}
        {narrative.missing.length ? (
          <p className="text-muted-foreground text-[11px]">
            Not on file: {narrative.missing.join("; ")}.
          </p>
        ) : null}
        {narrative.latestAttempt ? (
          <p className="text-muted-foreground text-[11px]" data-testid="narrative-failed">
            The latest attempt did not succeed (
            {narrative.latestAttempt.status.toLowerCase().replaceAll("_", " ")}), so nothing from it
            is shown.
          </p>
        ) : null}
      </section>

      {/* The Six Parts (Pillars) */}
      {s ? (
        <section aria-labelledby="pillars" className="space-y-3">
          <div>
            <h2 id="pillars" className="text-base font-semibold text-foreground">
              The six parts
            </h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              Open a part to see every reason behind it and the records it read.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {PILLARS.map(([key, label]) => {
              const value = s.pillars[key] ?? null;
              const weight = s.effectiveWeights[key];
              const reasons = s.reasons.filter((r) => r.pillar === key);
              return (
                <details
                  key={key}
                  open={reasons.some((r) => r.id === linked) || undefined}
                  className="surface rounded-xl border border-border/80 shadow-xs open:col-span-full overflow-hidden transition-all group/pillar"
                  data-testid={`pillar-${key}`}
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-2 p-4 hover:bg-muted/30 transition-colors select-none">
                    <span className="font-medium text-foreground text-sm">{label}</span>
                    <span className="text-xs tabular-nums">
                      {value === null ? (
                        <span className="text-muted-foreground">Not enough data</span>
                      ) : (
                        <>
                          <span className="font-semibold text-foreground">{value.toFixed(0)}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            · weight {Math.round((weight ?? 0) * 100)}%
                          </span>
                        </>
                      )}
                    </span>
                  </summary>
                  <ul className="divide-border/40 border-border/60 divide-y border-t text-sm">
                    {reasons.map((r) => (
                      <ReasonItem
                        key={r.id}
                        r={r}
                        main={r.id === s.riskReasonId}
                        linked={r.id === linked}
                      />
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* History */}
      {history.length > 1 ? (
        <section
          aria-labelledby="health-history"
          className="surface rounded-xl border border-border/80 p-5 shadow-xs space-y-3"
        >
          <h2 id="health-history" className="text-base font-semibold text-foreground">
            Health history (model v{model.version})
          </h2>
          <LineChart
            points={history
              .filter((h) => h.overall !== null)
              .map((h) => ({ label: day(h.asOf).replace(/, \d{4}$/, ""), value: h.overall! }))}
            valueLabel="Health score"
          />
          <details className="text-xs">
            <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
              Show the numbers
            </summary>
            <table className="mt-2.5 w-full max-w-sm text-xs">
              <caption className="sr-only">Health score by day</caption>
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th scope="col" className="text-left py-1 font-medium">Date</th>
                  <th scope="col" className="text-right py-1 font-medium">
                    Score
                  </th>
                  <th scope="col" className="text-left pl-3 py-1 font-medium">Level</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {history.map((h) => (
                  <tr key={h.asOf} className="hover:bg-muted/20">
                    <td className="py-1 text-muted-foreground">{day(h.asOf)}</td>
                    <td className="text-right py-1 tabular-nums font-semibold text-foreground">
                      {h.overall ?? "—"}
                    </td>
                    <td className="py-1 pl-3 font-medium">
                      <RiskBadge level={h.riskLevel} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      ) : null}
    </div>
  );
}
