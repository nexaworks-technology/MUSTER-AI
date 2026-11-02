import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatCalendarDate } from "@/lib/format";
import { SignalActions } from "./signal-actions";
import {
  CATEGORY_WORDS,
  outsideLabel,
  SEVERITY_WORDS,
  STATUS_WORDS,
} from "@/modules/signals/schemas";

/** One list for the account Signals tab and the portfolio (spec §6D: each signal explains itself). */
export interface SignalRow {
  id: string;
  accountId: string;
  account?: { name: string };
  ruleKey: string;
  category: keyof typeof CATEGORY_WORDS;
  severity: keyof typeof SEVERITY_WORDS;
  polarity: "RISK" | "OPPORTUNITY";
  status: keyof typeof STATUS_WORDS;
  title: string;
  explanation: string;
  episode: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedReason: string | null;
  falseAlarmReason: string | null;
  publicSourceUrl: string | null;
  publicSourceDate: Date | null;
  evidenceLinks: Array<{ label: string; href: string | null; missing: boolean }>;
}
export interface RuleFields {
  meaning: string;
  howDetected: string;
  typicalLeadTime: string;
  falseAlarmCauses: string;
}

const SEVERITY_STYLE = {
  CRITICAL: "border-red-300 bg-red-50 text-red-900",
  WARN: "border-amber-300 bg-amber-50 text-amber-900",
  INFO: "border-border bg-muted text-muted-foreground",
} as const;

export function SignalList({
  signals,
  rules,
  canAct,
  showAccount = false,
  today,
}: {
  signals: SignalRow[];
  rules: Map<string, RuleFields>;
  canAct: (s: SignalRow) => boolean;
  showAccount?: boolean;
  /** The workspace's today: outside events older than 30 days read "Reported <date>", never "New". */
  today: string;
}) {
  if (signals.length === 0)
    return <p className="text-muted-foreground text-sm">No signals match.</p>;
  return (
    <ul className="divide-border border-border divide-y rounded-md border" aria-label="Signals">
      {signals.map((s) => {
        const live = s.status === "OPEN" || s.status === "ACKNOWLEDGED";
        const rule = rules.get(s.ruleKey);
        return (
          <li
            key={s.id}
            id={`signal-${s.id}`}
            className="target:bg-muted scroll-mt-4 space-y-2 p-3 text-sm"
            data-testid="signal"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  SEVERITY_STYLE[s.severity],
                )}
              >
                {SEVERITY_WORDS[s.severity]}
              </span>
              {s.polarity === "OPPORTUNITY" ? (
                <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-900">
                  Opportunity
                </span>
              ) : null}
              <span className="font-medium">{s.title}</span>
              {showAccount && s.account ? (
                <Link
                  href={`/accounts/${s.accountId}/signals#signal-${s.id}`}
                  className="underline"
                >
                  {s.account.name}
                </Link>
              ) : null}
            </div>
            <p>{s.explanation}</p>
            <p className="text-muted-foreground text-xs">
              {CATEGORY_WORDS[s.category]} · {STATUS_WORDS[s.status]} · episode {s.episode} · first
              seen {formatCalendarDate(s.firstSeenAt)} · last seen{" "}
              {formatCalendarDate(s.lastSeenAt)}
              {s.publicSourceDate
                ? ` · ${outsideLabel(s.publicSourceDate.toISOString().slice(0, 10), today, 30)}`
                : ""}
            </p>
            {s.resolvedReason ? (
              <p className="text-muted-foreground text-xs">{s.resolvedReason}</p>
            ) : null}
            {s.falseAlarmReason ? (
              <p className="text-muted-foreground text-xs">False alarm: {s.falseAlarmReason}</p>
            ) : null}
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Evidence">
              {s.publicSourceUrl ? (
                <li>
                  <a
                    href={s.publicSourceUrl}
                    className="underline"
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                  >
                    Public source
                  </a>
                </li>
              ) : null}
              {s.evidenceLinks.map((e, i) => (
                <li key={i}>
                  {e.href ? (
                    <a href={e.href} className="underline">
                      {e.label}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{e.label}</span>
                  )}
                </li>
              ))}
            </ul>
            {rule ? (
              <details className="text-xs">
                <summary className="text-muted-foreground cursor-pointer">
                  About this signal
                </summary>
                <dl className="mt-1 grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
                  <dt className="font-medium">What it means</dt>
                  <dd>{rule.meaning}</dd>
                  <dt className="font-medium">How we detect it</dt>
                  <dd>{rule.howDetected}</dd>
                  <dt className="font-medium">How early it appears</dt>
                  <dd>{rule.typicalLeadTime}</dd>
                  <dt className="font-medium">What can make it a false alarm</dt>
                  <dd>{rule.falseAlarmCauses}</dd>
                </dl>
              </details>
            ) : null}
            {live && canAct(s) ? (
              <SignalActions signalId={s.id} title={s.title} status={s.status} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
