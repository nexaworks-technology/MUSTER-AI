import type { Metadata } from "next";
import {
  ActivateModelButton,
  ModelEditForm,
  RunBacktestButton,
} from "@/components/app/model-controls";
import { RISK_WORDS } from "@/components/app/risk-badge";
import { can } from "@/lib/auth/permissions";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { backtestRunning } from "@/modules/signals/service";
import { listModels, PILLAR_MEANING, type StoredBacktest } from "@/modules/health/service";
import { requireSettingsAccess } from "../access";

export const metadata: Metadata = { title: "Health model" };

const PILLARS = [
  "ADOPTION",
  "ENGAGEMENT",
  "SUPPORT",
  "RELATIONSHIP",
  "COMMERCIAL",
  "SENTIMENT",
] as const;
const LABELS = {
  ADOPTION: "Adoption",
  ENGAGEMENT: "Engagement",
  SUPPORT: "Support",
  RELATIONSHIP: "Relationship",
  COMMERCIAL: "Commercial",
  SENTIMENT: "Sentiment",
} as const;
const ORIGIN = {
  SYSTEM_DEFAULT: "Default weights",
  BACKTEST_PROPOSAL: "Proposed by back-test",
  HUMAN: "Edited by a person",
} as const;
const STATUS = { DRAFT: "Draft", ACTIVE: "Active", RETIRED: "Retired" } as const;
const day = (d: string) => formatCalendarDate(new Date(`${d}T00:00:00Z`));
const lead = (r: StoredBacktest["result"]) =>
  `mean lead ${r.meanLeadDays === null ? "—" : `${Math.round(r.meanLeadDays)} days`}, median ${r.medianLeadDays === null ? "—" : `${Math.round(r.medianLeadDays)} days`}`;

function Weights({
  weights,
  thresholds,
}: {
  weights: Record<string, number>;
  thresholds: { healthyMin: number; watchMin: number };
}) {
  return (
    <table className="w-full max-w-2xl text-sm">
      <caption className="sr-only">Pillar weights</caption>
      <thead className="text-muted-foreground text-left text-xs">
        <tr>
          <th scope="col">Part</th>
          <th scope="col" className="text-right">
            Weight
          </th>
          <th scope="col">What it measures</th>
        </tr>
      </thead>
      <tbody>
        {PILLARS.map((p) => (
          <tr key={p} className="border-border align-top">
            <td className="font-medium">{LABELS[p]}</td>
            <td className="text-right tabular-nums">{Math.round((weights[p] ?? 0) * 100)}%</td>
            <td className="text-muted-foreground">{PILLAR_MEANING[p]}</td>
          </tr>
        ))}
        <tr>
          <td className="font-medium" colSpan={3}>
            Healthy from {thresholds.healthyMin} · Watch from {thresholds.watchMin} · At Risk below{" "}
            {thresholds.watchMin}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Settings › Health model (spec §6C4, §6C6, M3 rule 5): the active version, the back-test
 * proposal with its results and runner-up, edits previewed before saving, explicit activation.
 */
export default async function HealthModelPage() {
  const ctx = await requireSettingsAccess("healthModel:propose");
  const [models, running] = await Promise.all([listModels(ctx), backtestRunning(ctx)]);
  const active = models.find((m) => m.status === "ACTIVE");
  // Only a proposal made after the active model went live is "the" proposal: an older draft was
  // compared with a model that is no longer active, so it stays in "All versions" only.
  const proposal = models.find(
    (m) =>
      m.proposedBy === "BACKTEST_PROPOSAL" &&
      m.status === "DRAFT" &&
      (!active?.activatedAt || m.createdAt > active.activatedAt),
  );
  const canActivate = can(ctx, "healthModel:activate") !== null;
  const tz = ctx.workspace.timezone;
  const editFrom = proposal ?? models.find((m) => m.backtest) ?? null;

  return (
    <div className="space-y-section max-w-4xl">
      {active ? (
        <section aria-labelledby="active" className="surface space-y-2 p-4">
          <h2 id="active" className="text-base font-semibold">
            Active: v{active.version} · {ORIGIN[active.proposedBy]}
          </h2>
          <p className="text-sm">
            {active.backtest
              ? active.backtest.sentence
              : "Default weights — not yet back-tested on your accounts."}
          </p>
          {active.activatedAt ? (
            <p className="text-muted-foreground text-xs">
              Active since {formatDateTime(active.activatedAt, tz)}
              {active.approvedBy
                ? ` · approved by ${active.approvedBy.user.name ?? active.approvedBy.user.email}`
                : ""}
            </p>
          ) : null}
          <Weights weights={active.config.pillarWeights} thresholds={active.config.thresholds} />
        </section>
      ) : null}

      <section aria-labelledby="propose" className="space-y-3">
        <h2 id="propose" className="text-base font-semibold">
          Proposed model
        </h2>
        <p className="text-muted-foreground text-sm">
          The proposal is found by trying every mix of weights (in 5-point steps) and thresholds on
          your own renewed and churned accounts, scoring each of them as of the weeks before its
          outcome, using only what was known then. Nothing changes until an Admin activates it.
        </p>
        <RunBacktestButton running={running} />
        {proposal?.backtest ? (
          <div className="surface space-y-3 p-4" data-testid="proposal">
            <h3 className="font-medium">
              v{proposal.version} · proposed {formatDateTime(proposal.createdAt, tz)}
            </h3>
            {proposal.backtest.sufficient ? (
              <p className="text-base font-medium" data-testid="proposal-sentence">
                {proposal.backtest.sentence}
              </p>
            ) : (
              <p className="text-sm">
                Not enough history to propose a model: {proposal.backtest.reason} Default weights
                stay in use, labelled &quot;not yet back-tested on your accounts&quot;.
              </p>
            )}
            <ul className="text-muted-foreground list-disc pl-5 text-sm">
              <li>
                Outcomes from {day(proposal.backtest.window.from)} to{" "}
                {day(proposal.backtest.window.to)} (last {proposal.backtest.window.months} months);
                each scored weekly over the 120 days before it; a churn counts as caught when At
                Risk at least 14 days before.
              </li>
              <li>This proposal: {lead(proposal.backtest.result)}.</li>
              {proposal.backtest.baseline ? (
                <li>
                  The active model (v{proposal.backtest.baseline.version}) on the same accounts:{" "}
                  {proposal.backtest.baseline.sentence}
                </li>
              ) : null}
              {proposal.backtest.runnerUp ? (
                <li>Runner-up: {proposal.backtest.runnerUp.sentence}</li>
              ) : null}
              {proposal.backtest.search ? (
                <li>
                  {proposal.backtest.search.evaluated.toLocaleString("en-US")} combinations tried in{" "}
                  {proposal.backtest.search.searchMs} ms (scoring the points took{" "}
                  {proposal.backtest.search.pointsMs} ms).
                </li>
              ) : null}
              {proposal.backtest.result.unscorable.length ? (
                <li>
                  Could not be scored (not enough data), so not counted:{" "}
                  {proposal.backtest.result.unscorable
                    .map(
                      (o) =>
                        `${o.name} (${o.type === "CHURN" ? "churned" : "renewed"} ${day(o.date)})`,
                    )
                    .join(", ")}
                  .
                </li>
              ) : null}
            </ul>
            <Weights
              weights={proposal.config.pillarWeights}
              thresholds={proposal.config.thresholds}
            />
            <details className="text-sm">
              <summary className="cursor-pointer">Every account in the back-test</summary>
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">Back-test results per account</caption>
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Result</th>
                    <th scope="col">Lowest level</th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.backtest.result.accounts.map((a) => {
                    const worst = ["AT_RISK", "WATCH", "HEALTHY", "INSUFFICIENT_DATA"].find((b) =>
                      a.points.some((p) => p.band === b),
                    ) as keyof typeof RISK_WORDS;
                    return (
                      <tr key={`${a.accountId}-${a.date}`}>
                        <td>{a.name}</td>
                        <td>
                          {a.type === "CHURN" ? "Churned" : "Renewed"} {day(a.date)}
                        </td>
                        <td>
                          {a.type === "CHURN"
                            ? a.caught
                              ? `Caught ${a.leadDays} days early`
                              : "Missed"
                            : a.falseAlarm
                              ? "False alarm"
                              : "No alarm"}
                        </td>
                        <td>{RISK_WORDS[worst]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
            {canActivate && proposal.backtest.sufficient ? (
              <ActivateModelButton modelId={proposal.id} version={proposal.version} />
            ) : null}
          </div>
        ) : null}
      </section>

      {editFrom ? (
        <section aria-labelledby="edit" className="surface space-y-3 p-5">
          <h2 id="edit" className="text-base font-semibold">
            Change the weights
          </h2>
          <ModelEditForm
            basedOnId={editFrom.id}
            basedOnVersion={editFrom.version}
            weights={editFrom.config.pillarWeights}
            thresholds={editFrom.config.thresholds}
          />
        </section>
      ) : null}

      <section aria-labelledby="versions" className="space-y-3">
        <h2 id="versions" className="text-base font-semibold">
          All versions
        </h2>
        <ul className="surface divide-border divide-y text-sm">
          {models.map((m) => (
            <li key={m.id} className="space-y-1 p-3" data-testid={`model-v${m.version}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  v{m.version} · {STATUS[m.status]} · {ORIGIN[m.proposedBy]}
                  {m.basedOnVersion ? ` · from v${m.basedOnVersion}` : ""}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(m.createdAt, tz)}
                </span>
              </div>
              <p className="text-muted-foreground">
                {m.backtest ? m.backtest.sentence : "Not back-tested."}
                {m.note ? ` ${m.note}` : ""}
              </p>
              {m.status === "DRAFT" && canActivate && m.proposedBy === "HUMAN" ? (
                <ActivateModelButton modelId={m.id} version={m.version} />
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
