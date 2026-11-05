import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { loadAccuracy, type AccuracyRow } from "@/modules/outcomes/service";
import { listRuleSettings } from "@/modules/signals/service";
import { KillRuleForm, TuneRuleForm } from "./controls";

export const metadata: Metadata = { title: "AI accuracy" };

const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
const humanize = (k: string) => k.replace(/[_-]/g, " ");
const SHOWS = ["true", "false", "undetermined", "approved", "rejected"] as const;
type Show = (typeof SHOWS)[number];
const rowHref = (param: "rule" | "agent", key: string, show?: Show): Route =>
  `/reports/ai-accuracy?${param}=${encodeURIComponent(key)}${show ? `&show=${show}` : ""}#records` as Route;
const ALARM_WORDS = { true: "True alarm", false: "False alarm", null: "Undetermined" } as const;

function leaves(o: Record<string, unknown>, prefix = ""): Array<[string, number]> {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "number"
      ? [[`${prefix}${k}`, v] as [string, number]]
      : v && typeof v === "object" && !Array.isArray(v)
        ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
        : [],
  );
}

function CountLink({
  param,
  k,
  show,
  n,
}: {
  param: "rule" | "agent";
  k: string;
  show: Show;
  n: number;
}) {
  return n === 0 ? (
    <span>0</span>
  ) : (
    <Link href={rowHref(param, k, show)} className="underline">
      {n}
    </Link>
  );
}

function Table({
  title,
  param,
  rows,
  label,
  showAcceptance,
}: {
  title: string;
  param: "rule" | "agent";
  rows: AccuracyRow[];
  label: (k: string) => string;
  showAcceptance: boolean;
}) {
  return (
    <section aria-labelledby={`t-${param}`} className="space-y-2">
      <h2 id={`t-${param}`} className="text-lg font-semibold">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing flagged in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="py-1 pr-3 font-medium">{param === "rule" ? "Rule" : "Agent"}</th>
                <th className="py-1 pr-3 font-medium">True alarms</th>
                <th className="py-1 pr-3 font-medium">False alarms</th>
                <th className="py-1 pr-3 font-medium">Undetermined</th>
                <th className="py-1 pr-3 font-medium">False-alarm rate</th>
                {showAcceptance ? <th className="py-1 pr-3 font-medium">CSM acceptance</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b align-top" data-testid={`${param}-${r.key}`}>
                  <td className="py-1 pr-3">
                    <Link href={rowHref(param, r.key)} className="underline">
                      {label(r.key)}
                    </Link>
                    {r.criesWolf ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                        Cries wolf
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1 pr-3">
                    <CountLink param={param} k={r.key} show="true" n={r.trueAlarms} />
                  </td>
                  <td className="py-1 pr-3">
                    <CountLink param={param} k={r.key} show="false" n={r.falseAlarms} />
                  </td>
                  <td className="py-1 pr-3">
                    <CountLink param={param} k={r.key} show="undetermined" n={r.undetermined} />
                  </td>
                  <td className="py-1 pr-3">
                    {pct(r.falseAlarmRate)}{" "}
                    <span className="text-muted-foreground">(of {r.determined} determined)</span>
                  </td>
                  {showAcceptance ? (
                    <td className="py-1 pr-3">
                      {pct(r.acceptanceRate)}{" "}
                      <span className="text-muted-foreground">
                        (<CountLink param={param} k={r.key} show="approved" n={r.approved} />{" "}
                        approved,{" "}
                        <CountLink param={param} k={r.key} show="rejected" n={r.rejected} />{" "}
                        rejected)
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Reports › AI accuracy (spec §6L3, D-163, D-167): how often each signal rule and agent was right,
 * from outcomes only. This page measures; it changes no model. Tune and Kill are the user's own
 * controls over the audited rule settings.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function AiAccuracyPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "reports:view")) notFound();
  const q = await searchParams;
  const canTune = can(ctx, "healthModel:propose");
  const [view, settingsRules] = await Promise.all([
    loadAccuracy(ctx),
    canTune ? listRuleSettings(ctx) : Promise.resolve([]),
  ]);
  const byKey = new Map(settingsRules.map((r) => [r.ruleKey, r]));
  const ruleLabel = (k: string) => byKey.get(k)?.label ?? humanize(k);
  const wolves = view.byRule.filter((r) => r.criesWolf);
  const t = view.thresholds;

  const param = one(q.agent) ? "agent" : one(q.rule) ? "rule" : null;
  const key = param ? one(q[param]) : undefined;
  const showRaw = one(q.show);
  const show = (SHOWS as readonly string[]).includes(showRaw ?? "") ? (showRaw as Show) : null;
  const picked =
    param && key
      ? (param === "agent" ? view.byAgent : view.byRule).find((r) => r.key === key)
      : undefined;
  const flagItems = (picked?.flagItems ?? []).filter(
    (i) =>
      show === null ||
      (show === "true" && i.alarm === true) ||
      (show === "false" && i.alarm === false) ||
      (show === "undetermined" && i.alarm === null),
  );
  const approvalItems = (picked?.approvalItems ?? []).filter(
    (i) =>
      show === null ||
      (show === "approved" && i.status !== "REJECTED") ||
      (show === "rejected" && i.status === "REJECTED"),
  );
  const showFlags = show === null || ["true", "false", "undetermined"].includes(show);
  const showApprovals =
    param === "agent" && (show === null || ["approved", "rejected"].includes(show));
  const name = (id: string | null) => (id ? (view.accountNames[id] ?? "Account") : "No account");

  return (
    <div className="space-y-8">
      <div>
        <Link href={"/reports" as Route} className="text-muted-foreground text-sm hover:underline">
          ← Reports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">AI accuracy</h1>
        <p className="text-muted-foreground text-sm">
          Risks whose 90-day check date fell in the last {view.windowDays} days, judged by what
          happened to the account. Every row links to the records behind it.
        </p>
      </div>

      <section aria-labelledby="defs" className="border-border space-y-1 rounded-md border p-3">
        <h2 id="defs" className="text-base font-semibold">
          What the words mean
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>True alarm:</strong> a risk flag whose account churned or contracted by its
            90-day check.
          </li>
          <li>
            <strong>False alarm:</strong> a signal a person marked as a false alarm, or an account
            that was healthy at day 90 and renewed with no action taken.
          </li>
          <li>
            <strong>Undetermined:</strong> anything else, including flags still waiting for day 90.
            Undetermined flags are left out of every rate.
          </li>
          <li>
            <strong>CSM acceptance:</strong> approved (including edited) over approved plus
            rejected. Expired and pending drafts are not counted.
          </li>
        </ul>
        <p className="text-muted-foreground text-sm">
          A rule cries wolf when more than {Math.round(t.criesWolfRate * 100)}% of its determined
          alarms were false, with at least {t.criesWolfMinDetermined} determined.
        </p>
      </section>

      <section aria-labelledby="wolf" className="space-y-2">
        <h2 id="wolf" className="text-lg font-semibold">
          Cries wolf
        </h2>
        {wolves.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No signal rule is over the threshold. Rules with fewer than {t.criesWolfMinDetermined}{" "}
            determined alarms are never listed here.
          </p>
        ) : (
          <ul className="space-y-3">
            {wolves.map((r) => {
              const rule = byKey.get(r.key);
              return (
                <li
                  key={r.key}
                  className="border-border space-y-2 rounded-md border p-3"
                  data-testid={`wolf-${r.key}`}
                >
                  <p className="text-sm">
                    <Link href={rowHref("rule", r.key)} className="font-medium underline">
                      {ruleLabel(r.key)}
                    </Link>
                    : {r.falseAlarms} of {r.determined} determined alarms were false (
                    {pct(r.falseAlarmRate)}).
                  </p>
                  {canTune && rule ? (
                    <div className="space-y-3">
                      {rule.enabled ? (
                        <>
                          <TuneRuleForm
                            ruleKey={r.key}
                            label={rule.label}
                            params={leaves(rule.params as Record<string, unknown>)}
                          />
                          <KillRuleForm ruleKey={r.key} label={rule.label} />
                        </>
                      ) : (
                        <p className="text-muted-foreground text-sm">
                          This rule is switched off. Switch it back on in Settings › Signals.
                        </p>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Table title="By agent" param="agent" rows={view.byAgent} label={humanize} showAcceptance />
      <Table
        title="By signal rule"
        param="rule"
        rows={view.byRule}
        label={ruleLabel}
        showAcceptance={false}
      />

      {picked ? (
        <section id="records" aria-labelledby="rec" className="space-y-2">
          <h2 id="rec" className="text-lg font-semibold">
            Records behind this number
          </h2>
          <p className="text-muted-foreground text-sm">
            {param === "agent" ? humanize(key!) : ruleLabel(key!)}
            {show ? `, ${show}` : ", all records"} ·{" "}
            <Link href={"/reports/ai-accuracy" as Route} className="underline">
              Clear
            </Link>
          </p>
          {showFlags ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th className="py-1 pr-3 font-medium">Account</th>
                    <th className="py-1 pr-3 font-medium">Flagged</th>
                    <th className="py-1 pr-3 font-medium">Result</th>
                    <th className="py-1 pr-3 font-medium">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {flagItems.map((i) => (
                    <tr key={i.outcomeRecordId} className="border-b" data-testid="flag-item">
                      <td className="py-1 pr-3">
                        <Link href={`/accounts/${i.accountId}` as Route} className="underline">
                          {name(i.accountId)}
                        </Link>
                      </td>
                      <td className="py-1 pr-3">{i.flaggedAt.toISOString().slice(0, 10)}</td>
                      <td className="py-1 pr-3">
                        {ALARM_WORDS[String(i.alarm) as "true" | "false" | "null"]}
                      </td>
                      <td className="py-1 pr-3">
                        <Link
                          href={`/reports/outcomes/${i.outcomeRecordId}` as Route}
                          className="underline"
                        >
                          Save record
                        </Link>
                        {i.signalId ? (
                          <>
                            {" · "}
                            <Link
                              href={`/accounts/${i.accountId}/signals` as Route}
                              className="underline"
                            >
                              Signal
                            </Link>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {flagItems.length === 0 ? (
                <p className="text-muted-foreground text-sm">No flags match.</p>
              ) : null}
            </div>
          ) : null}
          {showApprovals ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th className="py-1 pr-3 font-medium">Account</th>
                    <th className="py-1 pr-3 font-medium">Decision</th>
                    <th className="py-1 pr-3 font-medium">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {approvalItems.map((i) => (
                    <tr key={i.approvalId} className="border-b" data-testid="approval-item">
                      <td className="py-1 pr-3">{name(i.accountId)}</td>
                      <td className="py-1 pr-3">
                        {i.status === "REJECTED"
                          ? "Rejected"
                          : i.status === "EDITED_APPROVED"
                            ? "Approved after editing"
                            : "Approved"}
                      </td>
                      <td className="py-1 pr-3">
                        <Link href={`/approvals/${i.approvalId}` as Route} className="underline">
                          Approval
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : key ? (
        <p className="text-muted-foreground text-sm">No records for that row in this window.</p>
      ) : null}
    </div>
  );
}
