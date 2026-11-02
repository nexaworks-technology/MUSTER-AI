import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LineChart } from "@/components/app/line-chart";
import { PulseControls } from "@/components/app/pulse-controls";
import { RecomputeButton } from "@/components/app/recompute-button";
import { DisagreementMark, RISK_WORDS, RiskBadge } from "@/components/app/risk-badge";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
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

function ReasonItem({ r, main }: { r: Reason; main: boolean }) {
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
    <li className="space-y-1 p-3" data-testid="health-reason" data-kind={r.kind}>
      <p className={r.kind === "MISSING_DATA" ? "text-muted-foreground" : ""}>
        {main ? <span className="font-semibold">Main reason: </span> : null}
        {r.message}
      </p>
      {facts.length ? <p className="text-muted-foreground text-xs">{facts.join(" · ")}</p> : null}
      {r.sources.length ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Sources">
          {r.sources.map((s, i) => (
            <li key={i}>
              {s.href ? (
                <a href={s.href} className="underline">
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

export default async function HealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const health = await getAccountHealth(ctx, account.id);
  if (!health) notFound();
  const { snapshot: s, pulse, model, history } = health;
  const tz = ctx.workspace.timezone;

  return (
    <div className="space-y-6">
      <section aria-labelledby="health-score" className="space-y-3">
        <h2 id="health-score" className="text-base font-semibold">
          Health
        </h2>
        {!s ? (
          <p className="text-muted-foreground text-sm" data-testid="no-health">
            Health has not been calculated for this account yet. It is calculated every night and
            whenever someone presses Recompute.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-4xl font-semibold tabular-nums" data-testid="health-overall">
              {s.overall === null ? "—" : s.overall.toFixed(0)}
            </span>
            <RiskBadge level={s.riskLevel} />
            {s.pulseDisagreement ? <DisagreementMark /> : null}
            <span className="text-muted-foreground text-sm">
              as of {day(s.asOf)} · Health model v{model.version}
              {model.proposedBy === "SYSTEM_DEFAULT"
                ? " (default weights — not yet back-tested on your accounts)"
                : ""}
            </span>
          </div>
        )}
        {account.canEdit ? <RecomputeButton accountId={account.id} /> : null}
        {s && s.riskReasonId ? (
          <p className="text-sm">
            <span className="font-medium">Why At Risk: </span>
            {s.reasons.find((r) => r.id === s.riskReasonId)?.message}
          </p>
        ) : null}
      </section>

      <section
        id="pulse"
        aria-labelledby="pulse-heading"
        className="border-border space-y-2 rounded-md border p-3"
      >
        <h2 id="pulse-heading" className="text-sm font-semibold">
          CSM Pulse
        </h2>
        {pulse ? (
          <p className="text-sm" data-testid="pulse">
            <span className="font-medium">{PULSE_WORDS[pulse.value]}</span>
            {pulse.comment ? ` — "${pulse.comment}"` : ""} · {pulse.author},{" "}
            {formatDateTime(pulse.createdAt, tz)}
            {pulse.valid ? "" : " (older than 30 days, no longer counted)"}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">No Pulse yet.</p>
        )}
        {s?.pulseDisagreement && pulse ? (
          <p className="text-sm" data-testid="disagreement-detail">
            The numbers say {RISK_WORDS[s.riskLevelExcludingPulse]} (
            {s.overallExcludingPulse?.toFixed(0)} without the Pulse); {pulse.author} says{" "}
            {PULSE_WORDS[pulse.value]}. Both are shown; neither replaces the other.
          </p>
        ) : null}
        {account.canEdit ? <PulseControls accountId={account.id} /> : null}
      </section>

      {s ? (
        <section aria-labelledby="pillars" className="space-y-2">
          <h2 id="pillars" className="text-base font-semibold">
            The six parts
          </h2>
          <p className="text-muted-foreground text-sm">
            Open a part to see every reason behind it and the records it read.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {PILLARS.map(([key, label]) => {
              const value = s.pillars[key] ?? null;
              const weight = s.effectiveWeights[key];
              const reasons = s.reasons.filter((r) => r.pillar === key);
              return (
                <details
                  key={key}
                  className="border-border rounded-md border open:col-span-full"
                  data-testid={`pillar-${key}`}
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-2 p-3">
                    <span className="font-medium">{label}</span>
                    <span className="text-sm tabular-nums">
                      {value === null ? (
                        <span className="text-muted-foreground">Not enough data</span>
                      ) : (
                        <>
                          {value.toFixed(0)}
                          <span className="text-muted-foreground">
                            {" "}
                            · weight {Math.round((weight ?? 0) * 100)}%
                          </span>
                        </>
                      )}
                    </span>
                  </summary>
                  <ul className="divide-border border-border divide-y border-t text-sm">
                    {reasons.map((r) => (
                      <ReasonItem key={r.id} r={r} main={r.id === s.riskReasonId} />
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </section>
      ) : null}

      {history.length > 1 ? (
        <section aria-labelledby="health-history" className="space-y-2">
          <h2 id="health-history" className="text-base font-semibold">
            Health history (model v{model.version})
          </h2>
          <LineChart
            points={history
              .filter((h) => h.overall !== null)
              .map((h) => ({ label: day(h.asOf).replace(/, \d{4}$/, ""), value: h.overall! }))}
            valueLabel="Health score"
          />
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer">Show the numbers</summary>
            <table className="mt-2 w-full max-w-sm text-sm">
              <caption className="sr-only">Health score by day</caption>
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th scope="col" className="py-1">
                    Date
                  </th>
                  <th scope="col" className="py-1 text-right">
                    Score
                  </th>
                  <th scope="col" className="py-1">
                    Level
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.asOf} className="border-border border-t">
                    <td className="py-1">{day(h.asOf)}</td>
                    <td className="py-1 text-right tabular-nums">{h.overall ?? "—"}</td>
                    <td className="py-1">{RISK_WORDS[h.riskLevel]}</td>
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
