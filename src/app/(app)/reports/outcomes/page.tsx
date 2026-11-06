import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import {
  LEDGER_DEFINITIONS,
  LEDGER_PERIOD_DAYS,
  RECORD_FILTERS,
  filterRecords,
  fmtMoneyTotals,
  headlineSentence,
  loadLedger,
  type LedgerCounts,
  type LedgerGroup,
  type RecordFilter,
} from "@/modules/outcomes/service";

export const metadata: Metadata = { title: "Did it work?" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

interface Filters {
  period?: string;
  account?: string;
  play?: string;
  rule?: string;
  agent?: string;
  show?: string;
}
const href = (f: Filters): Route => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return `/reports/outcomes${s ? `?${s}` : ""}` as Route;
};

/**
 * Reports › Did it work? (spec §6L3, D-162): of the risks that reached their 90-day checkpoint,
 * what the team did and what came of it. Attributed, never causal (Q-15). Every figure links to
 * the records behind it.
 */
export default async function OutcomesReportPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "reports:view")) notFound();
  const p = await searchParams;
  const f: Filters = {
    period: one(p.period),
    account: one(p.account),
    play: one(p.play),
    rule: one(p.rule),
    agent: one(p.agent),
    show: one(p.show),
  };
  const view = await loadLedger(ctx, {
    period: f.period ? Number(f.period) : undefined,
    accountId: f.account,
    playKey: f.play,
    ruleKey: f.rule,
    agentKey: f.agent,
  });
  const { ledger, periodDays } = view;
  const show: RecordFilter = (RECORD_FILTERS as readonly string[]).includes(f.show ?? "")
    ? (f.show as RecordFilter)
    : "all";
  const keep = { ...f, period: String(periodDays) };
  const head = headlineSentence(ledger, periodDays);
  const t = ledger.totals;
  const records = filterRecords(ledger.records, show);
  const filtered = Boolean(f.account || f.play || f.rule || f.agent);
  const money = (m: LedgerCounts["savedMinor"]) => fmtMoneyTotals(m);

  const agentLabel = (k: string) =>
    k.startsWith("agent:")
      ? `Agent: ${k.slice(6)}`
      : k.startsWith("rule:")
        ? `Signal rule: ${k.slice(5)} (no agent)`
        : "Unknown source";
  const tables: Array<{
    id: string;
    title: string;
    param: "account" | "play" | "rule" | "agent";
    groups: LedgerGroup[];
    label: (k: string) => string;
  }> = [
    {
      id: "acct",
      title: "By account",
      param: "account",
      groups: ledger.byAccount,
      label: (k) => view.accountNames[k] ?? "Account",
    },
    {
      id: "play",
      title: "By play",
      param: "play",
      groups: ledger.byPlay,
      label: (k) => (k === "none" ? "No play" : (view.playNames[k] ?? k)),
    },
    { id: "agent", title: "By agent", param: "agent", groups: ledger.byAgent, label: agentLabel },
    {
      id: "rule",
      title: "By signal rule",
      param: "rule",
      groups: ledger.byRule,
      label: (k) => (k === "none" ? "No signal rule" : k),
    },
  ];

  return (
    <div className="space-y-section">
      <div>
        <Link href={"/reports" as Route} className="text-muted-foreground text-sm hover:underline">
          ← Reports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Did it work?</h1>
        <p className="text-muted-foreground text-sm">
          Risks are judged at their frozen 90-day checkpoint, from records only. A figure here is
          attributed to the flag, not proven to be caused by it.
        </p>
      </div>

      <nav aria-label="Period" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Checkpoint reached in the last</span>
        {LEDGER_PERIOD_DAYS.map((d) => (
          <Link
            key={d}
            href={href({ ...keep, period: String(d) })}
            aria-current={d === periodDays ? "page" : undefined}
            className={
              d === periodDays
                ? "border-primary bg-accent text-accent-foreground rounded-md border px-2 py-1 font-medium"
                : "border-input bg-card text-foreground hover:bg-hover rounded-md border px-2 py-1"
            }
          >
            {d} days
          </Link>
        ))}
        {filtered ? (
          <Link
            href={href({ period: keep.period })}
            className="text-primary ml-2 underline underline-offset-2"
          >
            Clear filters
          </Link>
        ) : null}
      </nav>

      <section aria-labelledby="headline-h" className="space-y-2" data-testid="ledger-headline">
        <h2 id="headline-h" className="sr-only">
          Headline
        </h2>
        <p className="text-lg">
          {head.text}
          {!head.empty ? <Badge className="ml-2 align-middle">{head.label}</Badge> : null}
        </p>
        {!head.empty ? (
          <p className="text-muted-foreground text-sm">
            <strong className="font-medium">Worth:</strong> {head.definition}
            {!ledger.moneyVisible ? " Money is restricted to members with revenue access." : ""}
          </p>
        ) : null}
        <p className="text-muted-foreground text-sm" data-testid="awaiting">
          {t.awaiting} risk flag{t.awaiting === 1 ? " is" : "s are"} still waiting for the 90-day
          checkpoint and not counted above. {LEDGER_DEFINITIONS.awaiting}
        </p>
      </section>

      {t.flagged > 0 || t.opportunityFlagged > 0 ? (
        <section aria-labelledby="counts-h" className="space-y-2">
          <h2 id="counts-h" className="text-lg font-semibold">
            The counts
          </h2>
          <ul className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            {(
              [
                ["Risks at their 90-day checkpoint", t.flagged, "all"],
                ["The team acted on", t.acted, "acted"],
                ["Not acted on", t.ignored, "ignored"],
                ["Recovered or renewed", t.recoveredOrRenewed, "recovered"],
                ["Saved (acted and recovered or renewed)", t.savedCount, "saved"],
                ["Churned", t.churned, "churned"],
                ["Contracted", t.contracted, "contracted"],
              ] as Array<[string, number, RecordFilter]>
            ).map(([label, n, s]) => (
              <li key={s}>
                <Link
                  href={href({ ...keep, show: s })}
                  className="text-primary tabular-nums underline underline-offset-2"
                >
                  {n}
                </Link>{" "}
                {label}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            Saved ARR: <span className="tabular-nums">{money(t.savedMinor)}</span>
            {t.savedWithoutArr > 0
              ? ` (${t.savedWithoutArr} saved flag${t.savedWithoutArr === 1 ? " has" : "s have"} no ARR on file and add no money)`
              : ""}
            . <span className="text-muted-foreground">{LEDGER_DEFINITIONS.saved}</span>
          </p>
          <p className="text-sm">
            Opportunities at their 90-day checkpoint: {t.opportunityFlagged};{" "}
            <Link
              href={href({ ...keep, show: "expanded" })}
              className="text-primary underline underline-offset-2"
            >
              {t.expandedCount}
            </Link>{" "}
            acted on and expanded, worth{" "}
            <span className="tabular-nums">{money(t.expandedMinor)}</span>.{" "}
            <span className="text-muted-foreground">{LEDGER_DEFINITIONS.expanded}</span>
          </p>
        </section>
      ) : null}

      {tables.map((tb) => (
        <section key={tb.id} aria-labelledby={`${tb.id}-h`} className="space-y-2">
          <h2 id={`${tb.id}-h`} className="text-lg font-semibold">
            {tb.title}
          </h2>
          {tb.groups.length === 0 ? (
            <p className="text-sm">Nothing to show for this period.</p>
          ) : (
            <div className="surface overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid={`table-${tb.id}`}>
                <caption className="sr-only">{tb.title}</caption>
                <thead>
                  <tr className="text-muted-foreground text-xs">
                    <th scope="col" className="font-normal">
                      {tb.title.replace("By ", "")}
                    </th>
                    <th scope="col" className="font-normal">
                      Reached day 90
                    </th>
                    <th scope="col" className="font-normal">
                      Acted
                    </th>
                    <th scope="col" className="font-normal">
                      Recovered or renewed
                    </th>
                    <th scope="col" className="font-normal">
                      Saved
                    </th>
                    <th scope="col" className="font-normal">
                      Saved ARR
                    </th>
                    <th scope="col" className="font-normal">
                      Churned
                    </th>
                    <th scope="col" className="font-normal">
                      Waiting
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tb.groups.map((g) => {
                    const to = (s: RecordFilter) => href({ ...keep, [tb.param]: g.key, show: s });
                    return (
                      <tr key={g.key} className="last:border-0">
                        <th scope="row" className="font-normal">
                          {tb.label(g.key)}
                        </th>
                        <td className="tabular-nums">
                          <Link
                            href={to("all")}
                            className="text-primary underline underline-offset-2"
                          >
                            {g.counts.flagged}
                          </Link>
                        </td>
                        <td className="tabular-nums">
                          <Link
                            href={to("acted")}
                            className="text-primary underline underline-offset-2"
                          >
                            {g.counts.acted}
                          </Link>
                        </td>
                        <td className="tabular-nums">
                          <Link
                            href={to("recovered")}
                            className="text-primary underline underline-offset-2"
                          >
                            {g.counts.recoveredOrRenewed}
                          </Link>
                        </td>
                        <td className="tabular-nums">
                          <Link
                            href={to("saved")}
                            className="text-primary underline underline-offset-2"
                          >
                            {g.counts.savedCount}
                          </Link>
                        </td>
                        <td className="tabular-nums">{money(g.counts.savedMinor)}</td>
                        <td className="tabular-nums">
                          <Link
                            href={to("churned")}
                            className="text-primary underline underline-offset-2"
                          >
                            {g.counts.churned}
                          </Link>
                        </td>
                        <td className="tabular-nums">{g.counts.awaiting}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <section aria-labelledby="records-h" className="space-y-2">
        <h2 id="records-h" className="text-lg font-semibold">
          The records behind these figures
          {show !== "all" ? ` (${show})` : ""}
        </h2>
        {show !== "all" ? (
          <Link
            href={href({ ...keep, show: undefined })}
            className="text-primary text-sm underline underline-offset-2"
          >
            Show all records
          </Link>
        ) : null}
        {records.length === 0 ? (
          <p className="text-sm" data-testid="no-records">
            No flags have reached their 90-day checkpoint yet
            {show !== "all" || filtered ? " that match this view" : ""}.
          </p>
        ) : (
          <div className="surface overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="records">
              <caption className="sr-only">Outcome records</caption>
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th scope="col" className="font-normal">
                    Account
                  </th>
                  <th scope="col" className="font-normal">
                    Flag
                  </th>
                  <th scope="col" className="font-normal">
                    Flagged
                  </th>
                  <th scope="col" className="font-normal">
                    Day-90 status
                  </th>
                  <th scope="col" className="font-normal">
                    Team
                  </th>
                  <th scope="col" className="font-normal">
                    Saved ARR
                  </th>
                  <th scope="col" className="font-normal">
                    Proof
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="last:border-0">
                    <th scope="row" className="font-normal">
                      <Link
                        href={`/accounts/${r.accountId}` as Route}
                        className="text-primary underline underline-offset-2"
                      >
                        {view.accountNames[r.accountId] ?? "Account"}
                      </Link>
                    </th>
                    <td>
                      {r.flagType === "RISK" ? "Risk" : "Opportunity"}
                      {r.signalId ? (
                        <>
                          {" · "}
                          <Link
                            href={`/accounts/${r.accountId}/signals` as Route}
                            className="text-primary underline underline-offset-2"
                          >
                            signal
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td>{fmtDate(r.flaggedAt)}</td>
                    <td>{r.status}</td>
                    <td>{r.actionTaken === "ACTED" ? "Acted" : "No action"}</td>
                    <td className="tabular-nums">
                      {r.savedMoney === null
                        ? r.saved
                          ? "No ARR on file"
                          : "—"
                        : typeof r.savedMoney === "string"
                          ? "Restricted"
                          : fmtMoneyTotals([r.savedMoney])}
                    </td>
                    <td>
                      <Link
                        href={`/reports/outcomes/${r.id}` as Route}
                        className="text-primary underline underline-offset-2"
                      >
                        Save record
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
